"""Patch only the current live DEV Lambda index and add folder operations; preserve every other ZIP entry."""
import argparse
import copy
from datetime import datetime, timezone
import base64
import hashlib
import io
import json
from pathlib import Path
import subprocess
import tempfile
import urllib.request
import zipfile

FUNCTION = "elettro-brand-os-dev-api"
REGION = "us-east-1"
MODULE_SOURCE_BASE64 = "aW1wb3J0IHtTZWNyZXRzTWFuYWdlckNsaWVudCxHZXRTZWNyZXRWYWx1ZUNvbW1hbmR9IGZyb20gIkBhd3Mtc2RrL2NsaWVudC1zZWNyZXRzLW1hbmFnZXIiOwpjb25zdCBzZWNyZXRzPW5ldyBTZWNyZXRzTWFuYWdlckNsaWVudCh7cmVnaW9uOiJ1cy1lYXN0LTEifSk7CmNvbnN0IEJSQU5EUz1uZXcgU2V0KFsic3Rhc2hib3giLCJlbGV0dHJvIiwic29sYXJtZWlzdGVyIiwid2VpZ2h0bG9zc2RhdmllIiwibmVja2VybWFubi1zdHJvbSIsInRoZXJhc2JveCJdKTsKZnVuY3Rpb24gcGF0aEluQnJhbmQodmFsdWUscm9vdCxhbGxvd1Jvb3Q9ZmFsc2UpewogaWYodHlwZW9mIHZhbHVlIT09InN0cmluZyJ8fHZhbHVlLmxlbmd0aD4yMDQ4fHwvW1xcXHgwMC1ceDFmXS8udGVzdCh2YWx1ZSkpdGhyb3cgbmV3IEVycm9yKCJJbnZhbGlkIGZvbGRlciBwYXRoIik7CiBjb25zdCBwYXRoPXZhbHVlLnJlcGxhY2UoL1wvKyQvLCIiKTsKIGlmKHBhdGguc3BsaXQoIi8iKS5zb21lKCh2LGkpPT5pPjAmJighdnx8dj09PSIuInx8dj09PSIuLiIpKSl0aHJvdyBuZXcgRXJyb3IoIlVuc2FmZSBmb2xkZXIgcGF0aCIpOwogaWYoIShhbGxvd1Jvb3QmJnBhdGgudG9Mb3dlckNhc2UoKT09PXJvb3QudG9Mb3dlckNhc2UoKSkmJiFwYXRoLnRvTG93ZXJDYXNlKCkuc3RhcnRzV2l0aChyb290LnRvTG93ZXJDYXNlKCkrIi8iKSkKICB0aHJvdyBuZXcgRXJyb3IoIkZvbGRlciBvdXRzaWRlIGJyYW5kLCBvciBicmFuZCByb290IGNhbm5vdCBiZSBtb3ZlZCIpOwogcmV0dXJuIHBhdGg7Cn0KYXN5bmMgZnVuY3Rpb24gYWNjZXNzVG9rZW4oKXsKIGNvbnN0IHJlc3VsdD1hd2FpdCBzZWNyZXRzLnNlbmQobmV3IEdldFNlY3JldFZhbHVlQ29tbWFuZCh7U2VjcmV0SWQ6cHJvY2Vzcy5lbnYuRFJPUEJPWF9TRUNSRVRfTkFNRXx8ImVsZXR0cm8tYnJhbmQtb3MtZGV2L2Ryb3Bib3gifSkpOwogY29uc3QgYz1KU09OLnBhcnNlKHJlc3VsdC5TZWNyZXRTdHJpbmd8fCJ7fSIpOwogY29uc3QgcmVmcmVzaD1jLnJlZnJlc2hfdG9rZW58fGMucmVmcmVzaFRva2VuLGtleT1jLmFwcF9rZXl8fGMuYXBwS2V5LHBhc3N3b3JkPWMuYXBwX3NlY3JldHx8Yy5hcHBTZWNyZXQ7CiBpZighcmVmcmVzaHx8IWtleXx8IXBhc3N3b3JkKXRocm93IG5ldyBFcnJvcigiRHJvcGJveCBjcmVkZW50aWFscyB1bmF2YWlsYWJsZSIpOwogY29uc3Qgcj1hd2FpdCBmZXRjaCgiaHR0cHM6Ly9hcGkuZHJvcGJveGFwaS5jb20vb2F1dGgyL3Rva2VuIix7bWV0aG9kOiJQT1NUIixib2R5Om5ldyBVUkxTZWFyY2hQYXJhbXMoewogIGdyYW50X3R5cGU6InJlZnJlc2hfdG9rZW4iLHJlZnJlc2hfdG9rZW46cmVmcmVzaCxjbGllbnRfaWQ6a2V5LGNsaWVudF9zZWNyZXQ6cGFzc3dvcmR9KSxzaWduYWw6QWJvcnRTaWduYWwudGltZW91dCgxMDAwMCl9KTsKIGlmKCFyLm9rKXRocm93IG5ldyBFcnJvcigiRHJvcGJveCBhdXRob3JpemF0aW9uIGZhaWxlZCIpOwogY29uc3QgdG9rZW49KGF3YWl0IHIuanNvbigpKS5hY2Nlc3NfdG9rZW47aWYoIXRva2VuKXRocm93IG5ldyBFcnJvcigiRHJvcGJveCB0b2tlbiBtaXNzaW5nIik7cmV0dXJuIHRva2VuOwp9CmFzeW5jIGZ1bmN0aW9uIGNhbGwodG9rZW4sZW5kcG9pbnQsYm9keSl7CiBjb25zdCByPWF3YWl0IGZldGNoKCJodHRwczovL2FwaS5kcm9wYm94YXBpLmNvbS8yL2ZpbGVzLyIrZW5kcG9pbnQse21ldGhvZDoiUE9TVCIsCiAgaGVhZGVyczp7YXV0aG9yaXphdGlvbjoiQmVhcmVyICIrdG9rZW4sImNvbnRlbnQtdHlwZSI6ImFwcGxpY2F0aW9uL2pzb24ifSxib2R5OkpTT04uc3RyaW5naWZ5KGJvZHkpLHNpZ25hbDpBYm9ydFNpZ25hbC50aW1lb3V0KDI1MDAwKX0pOwogaWYoIXIub2spdGhyb3cgbmV3IEVycm9yKHIuc3RhdHVzPT09NDA5PyJEcm9wYm94IGZvbGRlciBtaXNzaW5nIG9yIGRlc3RpbmF0aW9uIGNvbmZsaWN0cyI6IkRyb3Bib3ggZm9sZGVyIG9wZXJhdGlvbiBmYWlsZWQiKTsKIHJldHVybiByLmpzb24oKTsKfQpmdW5jdGlvbiByZWxvY2F0ZSh2YWx1ZSxmcm9tLHRvKXsKIHJldHVybiB0eXBlb2YgdmFsdWU9PT0ic3RyaW5nIiYmdmFsdWUudG9Mb3dlckNhc2UoKS5zdGFydHNXaXRoKGZyb20udG9Mb3dlckNhc2UoKSsiLyIpP3RvK3ZhbHVlLnNsaWNlKGZyb20ubGVuZ3RoKTp2YWx1ZTsKfQpleHBvcnQgYXN5bmMgZnVuY3Rpb24gbW92ZUJyYW5kRm9sZGVyKGJvZHksY29ubmVjdERhdGFiYXNlLGpzb24pewogbGV0IGNsaWVudCxmb2xkZXJJZCxzb3VyY2UsdGFyZ2V0LG1vdmVkPWZhbHNlLGNvbW1pdFN0YXJ0ZWQ9ZmFsc2U7CiB0cnl7CiAgaWYoYm9keS5jb25maXJtZWQhPT10cnVlfHwhQlJBTkRTLmhhcyhib2R5LmJyYW5kU2x1ZykpcmV0dXJuIGpzb24oNDAwLHtvazpmYWxzZSxlcnJvcjoiQ29uZmlybWVkIGJyYW5kIGZvbGRlciBvcGVyYXRpb24gcmVxdWlyZWQifSk7CiAgY29uc3Qgcm9vdD0iLzEtLS1lbGV0dHJvLWJyYW5kLW9zLyIrYm9keS5icmFuZFNsdWc7CiAgc291cmNlPXBhdGhJbkJyYW5kKGJvZHkucGF0aCxyb290KTsKICBjb25zdCBwYXJlbnQ9Ym9keS5vcGVyYXRpb249PT0icmVuYW1lIj9zb3VyY2Uuc2xpY2UoMCxzb3VyY2UubGFzdEluZGV4T2YoIi8iKSk6cGF0aEluQnJhbmQoYm9keS5wYXJlbnRQYXRoLHJvb3QsdHJ1ZSk7CiAgY29uc3QgbmFtZT1ib2R5Lm9wZXJhdGlvbj09PSJyZW5hbWUiP2JvZHkubmFtZTpzb3VyY2Uuc2xpY2Uoc291cmNlLmxhc3RJbmRleE9mKCIvIikrMSk7CiAgaWYoIVsicmVuYW1lIiwibW92ZSJdLmluY2x1ZGVzKGJvZHkub3BlcmF0aW9uKXx8dHlwZW9mIG5hbWUhPT0ic3RyaW5nInx8IW5hbWUudHJpbSgpfHxuYW1lLmxlbmd0aD4xODB8fAogICAvW1wvXFxceDAwLVx4MWZdLy50ZXN0KG5hbWUpfHxuYW1lPT09Ii4ifHxuYW1lPT09Ii4uIilyZXR1cm4ganNvbig0MDAse29rOmZhbHNlLGVycm9yOiJJbnZhbGlkIGZvbGRlciBvcGVyYXRpb24vbmFtZSJ9KTsKICB0YXJnZXQ9cGF0aEluQnJhbmQocGFyZW50KyIvIituYW1lLHJvb3QpOwogIGlmKHRhcmdldC50b0xvd2VyQ2FzZSgpPT09c291cmNlLnRvTG93ZXJDYXNlKCl8fHBhcmVudC50b0xvd2VyQ2FzZSgpPT09c291cmNlLnRvTG93ZXJDYXNlKCl8fAogICBwYXJlbnQudG9Mb3dlckNhc2UoKS5zdGFydHNXaXRoKHNvdXJjZS50b0xvd2VyQ2FzZSgpKyIvIikpcmV0dXJuIGpzb24oNDAwLHtvazpmYWxzZSxlcnJvcjoiU2VsZiBhbmQgZGVzY2VuZGFudCBtb3ZlcyBhcmUgYmxvY2tlZCJ9KTsKICBjbGllbnQ9YXdhaXQgY29ubmVjdERhdGFiYXNlKCk7YXdhaXQgY2xpZW50LnF1ZXJ5KCJCRUdJTiIpOwogIGF3YWl0IGNsaWVudC5xdWVyeSgiU0VMRUNUIHBnX2Fkdmlzb3J5X3hhY3RfbG9jayhoYXNodGV4dGV4dGVuZGVkKCQxLDApKSIsWyJlcGUtZm9sZGVyOiIrYm9keS5icmFuZFNsdWddKTsKICBjb25zdCBicmFuZD1hd2FpdCBjbGllbnQucXVlcnkoJ1NFTEVDVCAiaWQiIEZST00gIkJyYW5kIiBXSEVSRSAic2x1ZyI9JDEgQU5EICJzdGF0dXMiPSQyJyxbYm9keS5icmFuZFNsdWcsImFjdGl2ZSJdKTsKICBpZighYnJhbmQucm93c1swXSl0aHJvdyBuZXcgRXJyb3IoIkFjdGl2ZSBicmFuZCBub3QgZm91bmQiKTsKICBjb25zdCB0b2tlbj1hd2FpdCBhY2Nlc3NUb2tlbigpOwogIGNvbnN0IGZvbGRlcj1hd2FpdCBjYWxsKHRva2VuLCJnZXRfbWV0YWRhdGEiLHtwYXRoOnNvdXJjZX0pOwogIGlmKGZvbGRlclsiLnRhZyJdIT09ImZvbGRlciJ8fCFmb2xkZXIuaWQpdGhyb3cgbmV3IEVycm9yKCJTb3VyY2UgbXVzdCBiZSBhbiBleGlzdGluZyBmb2xkZXIiKTsKICBmb2xkZXJJZD1mb2xkZXIuaWQ7c291cmNlPXBhdGhJbkJyYW5kKGZvbGRlci5wYXRoX2Rpc3BsYXkscm9vdCk7CiAgY29uc3QgZGVzdGluYXRpb249YXdhaXQgY2FsbCh0b2tlbiwiZ2V0X21ldGFkYXRhIix7cGF0aDpwYXJlbnR9KTsKICBpZihkZXN0aW5hdGlvblsiLnRhZyJdIT09ImZvbGRlciIpdGhyb3cgbmV3IEVycm9yKCJEZXN0aW5hdGlvbiBwYXJlbnQgbXVzdCBiZSBhbiBleGlzdGluZyBmb2xkZXIiKTsKICBjb25zdCBmaWxlcz1uZXcgTWFwKCk7bGV0IGN1cnNvcixwYWdlcz0wOwogIGRvewogICBpZigrK3BhZ2VzPjIwKXRocm93IG5ldyBFcnJvcigiRm9sZGVyIGludmVudG9yeSB0b28gbGFyZ2UgZm9yIHRoaXMgb3BlcmF0aW9uOyB1c2UgdGhlIGRhc2hib2FyZCIpOwogICBjb25zdCBwYWdlPWF3YWl0IGNhbGwodG9rZW4sY3Vyc29yPyJsaXN0X2ZvbGRlci9jb250aW51ZSI6Imxpc3RfZm9sZGVyIixjdXJzb3I/e2N1cnNvcn06e3BhdGg6c291cmNlLHJlY3Vyc2l2ZTp0cnVlLGluY2x1ZGVfZGVsZXRlZDpmYWxzZSxsaW1pdDoyMDAwfSk7CiAgIGZvcihjb25zdCBlbnRyeSBvZiBwYWdlLmVudHJpZXN8fFtdKWlmKGVudHJ5WyIudGFnIl09PT0iZmlsZSImJmVudHJ5LmlkJiZlbnRyeS5wYXRoX2Rpc3BsYXk/LnRvTG93ZXJDYXNlKCkuc3RhcnRzV2l0aChzb3VyY2UudG9Mb3dlckNhc2UoKSsiLyIpKWZpbGVzLnNldChlbnRyeS5pZCxlbnRyeS5wYXRoX2Rpc3BsYXkpOwogICBjdXJzb3I9cGFnZS5oYXNfbW9yZT9wYWdlLmN1cnNvcjp1bmRlZmluZWQ7CiAgfXdoaWxlKGN1cnNvcik7CiAgY29uc3Qgc2VsZWN0ZWQ9YXdhaXQgY2xpZW50LnF1ZXJ5KGBTRUxFQ1QgImlkIiwiYnJhbmRJZCIsInNvdXJjZUZpbGVJZCIsInNvdXJjZUV4dGVybmFsSWQiLCJzb3VyY2VQYXRoIiwic291cmNlUGF0aExvd2VyIiwic291cmNlVXJsIiwic291cmNlTWV0YWRhdGEiCiAgIEZST00gIkFzc2V0IiBXSEVSRSAic291cmNlVHlwZSI9J2Ryb3Bib3gnIEFORAogICAgKCJzb3VyY2VGaWxlSWQiPUFOWSgkNDo6dGV4dFtdKSBPUiAic291cmNlRXh0ZXJuYWxJZCI9QU5ZKCQ0Ojp0ZXh0W10pIE9SCiAgICAgKCJicmFuZElkIj0kMSBBTkQgKGxlZnQobG93ZXIoY29hbGVzY2UoInNvdXJjZVBhdGgiLCcnKSksJDIpPSQzIE9SIGxlZnQobG93ZXIoY29hbGVzY2UoInNvdXJjZVVybCIsJycpKSwkMik9JDMpKSkgRk9SIFVQREFURWAsCiAgIFticmFuZC5yb3dzWzBdLmlkLHNvdXJjZS5sZW5ndGgrMSxzb3VyY2UudG9Mb3dlckNhc2UoKSsiLyIsWy4uLmZpbGVzLmtleXMoKV1dKTsKICBjb25zdCBjdXJyZW50UGF0aHM9bmV3IE1hcCgpLHNlZW5JZHM9bmV3IFNldCgpOwogIGZvcihjb25zdCBhc3NldCBvZiBzZWxlY3RlZC5yb3dzKXsKICAgaWYoYXNzZXQuYnJhbmRJZCE9PWJyYW5kLnJvd3NbMF0uaWQpdGhyb3cgbmV3IEVycm9yKCJBIGZvbGRlciBmaWxlIGlzIHJlZ2lzdGVyZWQgdW5kZXIgYW5vdGhlciBicmFuZDsgbW92ZSBzdG9wcGVkIik7CiAgIGNvbnN0IGlkcz1bYXNzZXQuc291cmNlRmlsZUlkLGFzc2V0LnNvdXJjZUV4dGVybmFsSWRdLmZpbHRlcih2PT52IT09bnVsbCYmdiE9PXVuZGVmaW5lZCYmdiE9PSIiKTsKICAgaWYoIWlkcy5sZW5ndGh8fGlkcy5zb21lKHY9PnR5cGVvZiB2IT09InN0cmluZyJ8fCF2LnN0YXJ0c1dpdGgoImlkOiIpKXx8bmV3IFNldChpZHMpLnNpemUhPT0xKXRocm93IG5ldyBFcnJvcigiQW4gYWZmZWN0ZWQgYXNzZXQgbGFja3MgYSBjb25zaXN0ZW50IERyb3Bib3ggSUQ7IG1vdmUgc3RvcHBlZCIpOwogICBpZihzZWVuSWRzLmhhcyhpZHNbMF0pKXRocm93IG5ldyBFcnJvcigiQSBmb2xkZXIgZmlsZSBoYXMgZHVwbGljYXRlIHJlZ2lzdGVyZWQgYXNzZXRzOyBtb3ZlIHN0b3BwZWQiKTsKICAgc2Vlbklkcy5hZGQoaWRzWzBdKTsKICAgY29uc3QgY3VycmVudFBhdGg9ZmlsZXMuZ2V0KGlkc1swXSk7CiAgIGlmKCFjdXJyZW50UGF0aCl0aHJvdyBuZXcgRXJyb3IoIkFuIGFmZmVjdGVkIGFzc2V0IGlzIGFic2VudCBmcm9tIHRoZSBmb2xkZXIgaW52ZW50b3J5OyByZWNvbmNpbGUgYmVmb3JlIG1vdmluZyIpOwogICBjdXJyZW50UGF0aHMuc2V0KGFzc2V0LmlkLGN1cnJlbnRQYXRoKTsKICB9CiAgY29uc3QgcmVzdWx0PWF3YWl0IGNhbGwodG9rZW4sIm1vdmVfdjIiLHtmcm9tX3BhdGg6Zm9sZGVySWQsdG9fcGF0aDp0YXJnZXQsYXV0b3JlbmFtZTpmYWxzZSxhbGxvd19zaGFyZWRfZm9sZGVyOmZhbHNlLGFsbG93X293bmVyc2hpcF90cmFuc2ZlcjpmYWxzZX0pOwogIG1vdmVkPXRydWU7CiAgaWYocmVzdWx0Lm1ldGFkYXRhPy5pZCE9PWZvbGRlcklkfHwhcmVzdWx0Lm1ldGFkYXRhLnBhdGhfZGlzcGxheSl0aHJvdyBuZXcgRXJyb3IoIk1vdmVkIGZvbGRlciBpZGVudGl0eSBub3QgdmVyaWZpZWQiKTsKICB0YXJnZXQ9cGF0aEluQnJhbmQocmVzdWx0Lm1ldGFkYXRhLnBhdGhfZGlzcGxheSxyb290KTsKICBmb3IoY29uc3QgYXNzZXQgb2Ygc2VsZWN0ZWQucm93cyl7CiAgIGNvbnN0IG5ld1BhdGg9cmVsb2NhdGUoY3VycmVudFBhdGhzLmdldChhc3NldC5pZCksc291cmNlLHRhcmdldCk7CiAgIGNvbnN0IGRhdGE9YXNzZXQuc291cmNlTWV0YWRhdGEmJnR5cGVvZiBhc3NldC5zb3VyY2VNZXRhZGF0YT09PSJvYmplY3QiP3suLi5hc3NldC5zb3VyY2VNZXRhZGF0YX06e307CiAgIGZvcihjb25zdCBrZXkgb2YgWyJwYXRoIiwicGF0aF9kaXNwbGF5IiwicGF0aF9sb3dlciJdKWlmKHR5cGVvZiBkYXRhW2tleV09PT0ic3RyaW5nIilkYXRhW2tleV09a2V5PT09InBhdGhfbG93ZXIiP25ld1BhdGgudG9Mb3dlckNhc2UoKTpuZXdQYXRoOwogICBhd2FpdCBjbGllbnQucXVlcnkoYFVQREFURSAiQXNzZXQiIFNFVCAic291cmNlUGF0aCI9JDIsInNvdXJjZVBhdGhMb3dlciI9JDMsInNvdXJjZVVybCI9JDQsInNvdXJjZU1ldGFkYXRhIj0kNTo6anNvbmIsInVwZGF0ZWRBdCI9Q1VSUkVOVF9USU1FU1RBTVAgV0hFUkUgImlkIj0kMWAsCiAgICBbYXNzZXQuaWQsdHlwZW9mIGFzc2V0LnNvdXJjZVBhdGg9PT0ic3RyaW5nIj9uZXdQYXRoOm51bGwsdHlwZW9mIGFzc2V0LnNvdXJjZVBhdGhMb3dlcj09PSJzdHJpbmciP25ld1BhdGgudG9Mb3dlckNhc2UoKTpudWxsLAogICAgIHR5cGVvZiBhc3NldC5zb3VyY2VVcmw9PT0ic3RyaW5nIiYmYXNzZXQuc291cmNlVXJsLnN0YXJ0c1dpdGgoIi8iKT9uZXdQYXRoOmFzc2V0LnNvdXJjZVVybCxKU09OLnN0cmluZ2lmeShkYXRhKV0pOwogIH0KICBjb21taXRTdGFydGVkPXRydWU7YXdhaXQgY2xpZW50LnF1ZXJ5KCJDT01NSVQiKTsKICByZXR1cm4ganNvbigyMDAse29rOnRydWUsZHJvcGJveEZvbGRlcklkOmZvbGRlcklkLHByZXZpb3VzUGF0aDpzb3VyY2UscGF0aDp0YXJnZXQsYXNzZXRzU3luY2hyb25pemVkOnNlbGVjdGVkLnJvd3MubGVuZ3RoLAogICBub3RlOiJGb2xkZXIgSUQgYW5kIGZpbGUgSURzIHByZXNlcnZlZDsgYXNzZXQgd29ya2Zsb3cgc3RhdHVzZXMgdW5jaGFuZ2VkIn0pOwogfWNhdGNoKGVycm9yKXsKICBpZihjbGllbnQpYXdhaXQgY2xpZW50LnF1ZXJ5KCJST0xMQkFDSyIpLmNhdGNoKCgpPT57fSk7CiAgbGV0IHJlc3RvcmVkPWZhbHNlOwogIC8vIEEgbG9zdCBDT01NSVQgcmVzcG9uc2UgaXMgYW1iaWd1b3VzLiBEbyBub3QgY29tcGVuc2F0ZSBpbiB0aGF0IGNhc2UuCiAgaWYobW92ZWQmJiFjb21taXRTdGFydGVkKXt0cnl7Y29uc3Qgcj1hd2FpdCBjYWxsKGF3YWl0IGFjY2Vzc1Rva2VuKCksIm1vdmVfdjIiLHtmcm9tX3BhdGg6Zm9sZGVySWQsdG9fcGF0aDpzb3VyY2UsYXV0b3JlbmFtZTpmYWxzZSxhbGxvd19zaGFyZWRfZm9sZGVyOmZhbHNlLGFsbG93X293bmVyc2hpcF90cmFuc2ZlcjpmYWxzZX0pO3Jlc3RvcmVkPXIubWV0YWRhdGE/LmlkPT09Zm9sZGVySWQ7fWNhdGNoe319CiAgcmV0dXJuIGpzb24obW92ZWQmJiFyZXN0b3JlZD8yMDA6NDA5LHtvazpmYWxzZSxyZWNvbmNpbGlhdGlvblJlcXVpcmVkOm1vdmVkJiYhcmVzdG9yZWQsbW92ZVJvbGxlZEJhY2s6cmVzdG9yZWQsCiAgIC4uLihmb2xkZXJJZD97ZHJvcGJveEZvbGRlcklkOmZvbGRlcklkLHByZXZpb3VzUGF0aDpzb3VyY2UsZGVzdGluYXRpb25QYXRoOnRhcmdldH06e30pLAogICBlcnJvcjplcnJvciBpbnN0YW5jZW9mIEVycm9yP2Vycm9yLm1lc3NhZ2U6IkZvbGRlciBvcGVyYXRpb24gZmFpbGVkIiwKICAgLi4uKG1vdmVkJiYhcmVzdG9yZWQ/e21lc3NhZ2U6IkRyb3Bib3ggbWF5IGhhdmUgbW92ZWQgdGhlIGZvbGRlci4gRG8gbm90IHJldHJ5IHRoZSBtb3ZlOyByZWNvbmNpbGUgdGhpcyBmb2xkZXIgSUQgYW5kIHJlZ2lzdGVyZWQgcGF0aHMuIn06e30pfSk7CiB9ZmluYWxseXtpZihjbGllbnQpYXdhaXQgY2xpZW50LmVuZCgpLmNhdGNoKCgpPT57fSk7fQp9CmV4cG9ydCBhc3luYyBmdW5jdGlvbiByZXBhaXJDbGF1ZGVUZXN0U3RhdHVzKGNvbm5lY3REYXRhYmFzZSxqc29uKXsKIGxldCBjbGllbnQ7CiB0cnl7CiAgY2xpZW50PWF3YWl0IGNvbm5lY3REYXRhYmFzZSgpO2F3YWl0IGNsaWVudC5xdWVyeSgiQkVHSU4iKTsKICBjb25zdCByZXN1bHQ9YXdhaXQgY2xpZW50LnF1ZXJ5KGBTRUxFQ1QgYS4iaWQiLGEuInRpdGxlIixhLiJ0YWdzIixhLiJpbmdlc3RTdGF0dXMiLGEuImFwcHJvdmFsU3RhdHVzIixiLiJzbHVnIiBGUk9NICJBc3NldCIgYQogICBKT0lOICJCcmFuZCIgYiBPTiBiLiJpZCI9YS4iYnJhbmRJZCIgV0hFUkUgYS4iaWQiPSQxIEZPUiBVUERBVEUgT0YgYWAsWyIwMWUyNTUzMS1iNDNjLTQ3OGYtOTNmYS05YTlmNjVhMmVlODkiXSk7CiAgY29uc3QgYXNzZXQ9cmVzdWx0LnJvd3NbMF07CiAgaWYoIWFzc2V0fHxhc3NldC5zbHVnIT09ImVsZXR0cm8ifHxhc3NldC50aXRsZSE9bnVsbHx8YXNzZXQuYXBwcm92YWxTdGF0dXMhPT0iYXBwcm92ZWQifHwKICAgIUFycmF5LmlzQXJyYXkoYXNzZXQudGFncyl8fGFzc2V0LnRhZ3MubGVuZ3RofHwhWyJyYXciLCJuZWVkc19tZXRhZGF0YSJdLmluY2x1ZGVzKGFzc2V0LmluZ2VzdFN0YXR1cykpCiAgIHRocm93IG5ldyBFcnJvcigiVGVzdCBhc3NldCBubyBsb25nZXIgbWF0Y2hlcyB0aGUgcmVjb3JkZWQgc3RhdGU7IHJlcGFpciBzdG9wcGVkIik7CiAgY29uc3QgY2hhbmdlZD1hc3NldC5pbmdlc3RTdGF0dXMhPT0icmF3IjsKICBpZihjaGFuZ2VkKWF3YWl0IGNsaWVudC5xdWVyeSgnVVBEQVRFICJBc3NldCIgU0VUICJpbmdlc3RTdGF0dXMiPSQyOjoiSW5nZXN0U3RhdHVzIiwidXBkYXRlZEF0Ij1DVVJSRU5UX1RJTUVTVEFNUCBXSEVSRSAiaWQiPSQxJyxbYXNzZXQuaWQsInJhdyJdKTsKICBhd2FpdCBjbGllbnQucXVlcnkoIkNPTU1JVCIpO3JldHVybiBqc29uKDIwMCx7b2s6dHJ1ZSxhc3NldElkOmFzc2V0LmlkLGluZ2VzdFN0YXR1czoicmF3IixjaGFuZ2VkLAogICBub3RlOiJPbmx5IHRoZSBkb2N1bWVudGVkIGluZ2VzdFN0YXR1cyBzaWRlIGVmZmVjdCB3YXMgcmVwYWlyZWQ7IGVucmljaG1lbnRTdGF0dXMgd2FzIG5vdCBndWVzc2VkIn0pOwogfWNhdGNoKGVycm9yKXtpZihjbGllbnQpYXdhaXQgY2xpZW50LnF1ZXJ5KCJST0xMQkFDSyIpLmNhdGNoKCgpPT57fSk7cmV0dXJuIGpzb24oNDA5LHtvazpmYWxzZSxlcnJvcjplcnJvci5tZXNzYWdlfSk7fQogZmluYWxseXtpZihjbGllbnQpYXdhaXQgY2xpZW50LmVuZCgpLmNhdGNoKCgpPT57fSk7fQp9Cg=="

def aws(*args):
    result = subprocess.run(["aws", *args, "--region", REGION, "--output", "json"], capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError("AWS operation failed: " + result.stderr[:1000])
    return json.loads(result.stdout) if result.stdout.strip() else {}

def patch_index(source):
    required = ["completeDropboxUpload", "handleDropboxUploadSession", "preserveWorkflowState", "connectDatabase", "const dropboxAction = event.action || routedBody.action;"]
    if not all(marker in source for marker in required):
        raise RuntimeError("Live Lambda does not match the recovered baseline. No deployment attempted.")
    if 'from "./claude-folder-ops.mjs"' in source:
        return source
    source = 'import {moveBrandFolder,repairClaudeTestStatus} from "./claude-folder-ops.mjs";\n' + source
    anchor = 'export const handler = async (event = {}) => {'
    if source.count(anchor) != 1:
        raise RuntimeError("Handler insertion point ambiguous")
    source = source.replace(anchor, anchor + '\n  // IAM-only one-record repair, never exposed through HTTP or MCP.\n  if(event.action === "repair-claude-title-test-status" && !event.requestContext && !event.rawPath && !event.path) return repairClaudeTestStatus(connectDatabase,json);', 1)
    anchor = 'const dropboxAction = event.action || routedBody.action;'
    source = source.replace(anchor, anchor + '\n  if(dropboxAction === "move-brand-folder") return moveBrandFolder(routedBody,connectDatabase,json);', 1)
    return source

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--deploy", action="store_true")
    parser.add_argument("--repair-test", action="store_true")
    args = parser.parse_args()
    live = aws("lambda", "get-function", "--function-name", FUNCTION)
    config = live["Configuration"]
    with urllib.request.urlopen(live["Code"]["Location"], timeout=90) as response:
        original = response.read()
    if base64.b64encode(hashlib.sha256(original).digest()).decode() != config["CodeSha256"]:
        raise RuntimeError("Live ZIP hash did not match AWS configuration")
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    backup = Path(FUNCTION + "-before-claude-folders-" + stamp + ".zip").resolve()
    backup.write_bytes(original)
    archive = zipfile.ZipFile(io.BytesIO(original))
    if archive.namelist().count("index.mjs") != 1 or len(archive.namelist()) != len(set(archive.namelist())):
        raise RuntimeError("Unexpected archive layout")
    source = patch_index(archive.read("index.mjs").decode())
    module = base64.b64decode(MODULE_SOURCE_BASE64).decode()
    with tempfile.TemporaryDirectory() as directory:
        for name, text in [("index.mjs", source), ("claude-folder-ops.mjs", module)]:
            path = Path(directory) / name
            path.write_text(text)
            subprocess.run(["node", "--check", str(path)], check=True, capture_output=True)
    output = Path(FUNCTION + "-claude-folders.zip").resolve()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as result:
        for item in archive.infolist():
            if item.filename == "claude-folder-ops.mjs":
                continue
            result.writestr(copy.copy(item), source.encode() if item.filename == "index.mjs" else archive.read(item.filename))
        result.writestr("claude-folder-ops.mjs", module)
    check = zipfile.ZipFile(output)
    for name in archive.namelist():
        if name not in {"index.mjs", "claude-folder-ops.mjs"} and check.read(name) != archive.read(name):
            raise RuntimeError("Unexpected change to archive entry: " + name)
    print("Saved live backup: " + str(backup))
    print("Prepared patch: index.mjs and claude-folder-ops.mjs only. All other ZIP entries preserved.")
    if not args.deploy:
        print("Prepared only. Run with --deploy to deploy; --repair-test repairs the recorded test asset.")
        return
    updated = aws("lambda", "update-function-code", "--function-name", FUNCTION,
                  "--zip-file", "fileb://" + str(output), "--revision-id", config["RevisionId"])
    aws("lambda", "wait", "function-updated-v2", "--function-name", FUNCTION)
    saved = aws("lambda", "get-function-configuration", "--function-name", FUNCTION)
    if saved["CodeSha256"] != base64.b64encode(hashlib.sha256(output.read_bytes()).digest()).decode():
        raise RuntimeError("Post-deployment code hash changed; stop and inspect the live function")
    print("Verified DEV Lambda deployment; every pre-existing dependency and other module preserved.")
    if args.repair_test:
        response = Path("claude-test-status-repair.json").resolve()
        result = aws("lambda", "invoke", "--function-name", FUNCTION,
                     "--payload", base64.b64encode(b'{"action":"repair-claude-title-test-status"}').decode(), str(response))
        if result.get("FunctionError"):
            raise RuntimeError("Repair invocation failed; inspect claude-test-status-repair.json")
        payload = json.loads(response.read_text())
        value = json.loads(payload.get("body", "{}"))
        print(json.dumps(value, indent=2))
        if payload.get("statusCode") != 200 or value.get("ok") is not True:
            raise RuntimeError("Recorded asset did not match repair guard; nothing was changed by the repair")

if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        raise SystemExit("STOP: " + str(error)) from None
