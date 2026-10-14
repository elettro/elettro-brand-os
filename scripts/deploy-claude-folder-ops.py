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
MODULE_SOURCE_BASE64 = 'aW1wb3J0IHtMYW1iZGFDbGllbnQsSW52b2tlQ29tbWFuZH0gZnJvbSAiQGF3cy1zZGsvY2xpZW50LWxhbWJkYSI7CmNvbnN0IHJlbGF5PW5ldyBMYW1iZGFDbGllbnQoe3JlZ2lvbjoidXMtZWFzdC0xIixtYXhBdHRlbXB0czoxfSk7CmNvbnN0IEJSQU5EUz1uZXcgU2V0KFsic3Rhc2hib3giLCJlbGV0dHJvIiwic29sYXJtZWlzdGVyIiwid2VpZ2h0bG9zc2RhdmllIiwibmVja2VybWFubi1zdHJvbSIsInRoZXJhc2JveCJdKTsKZnVuY3Rpb24gcGF0aEluQnJhbmQodmFsdWUscm9vdCxhbGxvd1Jvb3Q9ZmFsc2UpewogaWYodHlwZW9mIHZhbHVlIT09InN0cmluZyJ8fHZhbHVlLmxlbmd0aD4yMDQ4fHwvW1xcXHgwMC1ceDFmXS8udGVzdCh2YWx1ZSkpdGhyb3cgbmV3IEVycm9yKCJJbnZhbGlkIGZvbGRlciBwYXRoIik7CiBjb25zdCBwYXRoPXZhbHVlLnJlcGxhY2UoL1wvKyQvLCIiKTsKIGlmKHBhdGguc3BsaXQoIi8iKS5zb21lKCh2LGkpPT5pPjAmJighdnx8dj09PSIuInx8dj09PSIuLiIpKSl0aHJvdyBuZXcgRXJyb3IoIlVuc2FmZSBmb2xkZXIgcGF0aCIpOwogaWYoIShhbGxvd1Jvb3QmJnBhdGgudG9Mb3dlckNhc2UoKT09PXJvb3QudG9Mb3dlckNhc2UoKSkmJiFwYXRoLnRvTG93ZXJDYXNlKCkuc3RhcnRzV2l0aChyb290LnRvTG93ZXJDYXNlKCkrIi8iKSkKICB0aHJvdyBuZXcgRXJyb3IoIkZvbGRlciBvdXRzaWRlIGJyYW5kLCBvciBicmFuZCByb290IGNhbm5vdCBiZSBtb3ZlZCIpOwogcmV0dXJuIHBhdGg7Cn0KYXN5bmMgZnVuY3Rpb24gY2FsbChjb250ZXh0LGVuZHBvaW50LGJvZHkpewogaWYoRGF0ZS5ub3coKT5jb250ZXh0LmRlYWRsaW5lKXRocm93IG5ldyBFcnJvcigiRm9sZGVyIG9wZXJhdGlvbiB0aW1lIGJ1ZGdldCBleGhhdXN0ZWQgYmVmb3JlIG5leHQgc3RlcCIpOwogY29uc3QgZnVuY3Rpb25OYW1lPXByb2Nlc3MuZW52LkRST1BCT1hfU1lOQ19GVU5DVElPTl9OQU1FOwogaWYoIWZ1bmN0aW9uTmFtZSl0aHJvdyBuZXcgRXJyb3IoIkRyb3Bib3ggd29ya2VyIGlzIG5vdCBjb25maWd1cmVkIik7CiBjb25zb2xlLmluZm8oIltjbGF1ZGUtZm9sZGVyXSB3b3JrZXIiLGVuZHBvaW50KTsKIGxldCByZXNwb25zZTsKIHRyeXsKICBjb25zdCByZXN1bHQ9YXdhaXQgcmVsYXkuc2VuZChuZXcgSW52b2tlQ29tbWFuZCh7RnVuY3Rpb25OYW1lOmZ1bmN0aW9uTmFtZSxJbnZvY2F0aW9uVHlwZToiUmVxdWVzdFJlc3BvbnNlIiwKICAgUGF5bG9hZDpCdWZmZXIuZnJvbShKU09OLnN0cmluZ2lmeSh7YWN0aW9uOiJjbGF1ZGUtZm9sZGVyLXJlbGF5LXYxIixicmFuZFNsdWc6Y29udGV4dC5icmFuZFNsdWcsZW5kcG9pbnQsYm9keX0pKX0pLAogICB7YWJvcnRTaWduYWw6QWJvcnRTaWduYWwudGltZW91dCgxMjAwMCl9KTsKICBpZihyZXN1bHQuRnVuY3Rpb25FcnJvcil0aHJvdyBuZXcgRXJyb3IoIkRyb3Bib3ggd29ya2VyIGludm9jYXRpb24gZmFpbGVkIik7CiAgcmVzcG9uc2U9SlNPTi5wYXJzZShCdWZmZXIuZnJvbShyZXN1bHQuUGF5bG9hZHx8W10pLnRvU3RyaW5nKCJ1dGY4IikpOwogfWNhdGNoKGVycm9yKXtlcnJvci51bmNlcnRhaW5Nb3ZlPWVuZHBvaW50PT09Im1vdmVfdjIiO3Rocm93IGVycm9yO30KIGlmKHJlc3BvbnNlLm9rIT09dHJ1ZSl7Y29uc3QgZXJyb3I9bmV3IEVycm9yKHJlc3BvbnNlLmVycm9yfHwiRHJvcGJveCBmb2xkZXIgd29ya2VyIGZhaWxlZCIpOwogIGVycm9yLnVuY2VydGFpbk1vdmU9cmVzcG9uc2UudW5jZXJ0YWluTW92ZT09PXRydWU7dGhyb3cgZXJyb3I7fQogcmV0dXJuIHJlc3BvbnNlLnJlc3VsdDsKfQpmdW5jdGlvbiByZWxvY2F0ZSh2YWx1ZSxmcm9tLHRvKXsKIHJldHVybiB0eXBlb2YgdmFsdWU9PT0ic3RyaW5nIiYmdmFsdWUudG9Mb3dlckNhc2UoKS5zdGFydHNXaXRoKGZyb20udG9Mb3dlckNhc2UoKSsiLyIpP3RvK3ZhbHVlLnNsaWNlKGZyb20ubGVuZ3RoKTp2YWx1ZTsKfQpleHBvcnQgYXN5bmMgZnVuY3Rpb24gbW92ZUJyYW5kRm9sZGVyKGJvZHksY29ubmVjdERhdGFiYXNlLGpzb24pewogbGV0IGNsaWVudCxmb2xkZXJJZCxzb3VyY2UsdGFyZ2V0LG1vdmVkPWZhbHNlLGNvbW1pdFN0YXJ0ZWQ9ZmFsc2UsdW5jZXJ0YWluTW92ZT1mYWxzZTsKIHRyeXsKICBpZihib2R5LmNvbmZpcm1lZCE9PXRydWV8fCFCUkFORFMuaGFzKGJvZHkuYnJhbmRTbHVnKSlyZXR1cm4ganNvbig0MDAse29rOmZhbHNlLGVycm9yOiJDb25maXJtZWQgYnJhbmQgZm9sZGVyIG9wZXJhdGlvbiByZXF1aXJlZCJ9KTsKICBjb25zdCByb290PSIvMS0tLWVsZXR0cm8tYnJhbmQtb3MvIitib2R5LmJyYW5kU2x1ZzsKICBzb3VyY2U9cGF0aEluQnJhbmQoYm9keS5wYXRoLHJvb3QpOwogIGNvbnN0IHBhcmVudD1ib2R5Lm9wZXJhdGlvbj09PSJyZW5hbWUiP3NvdXJjZS5zbGljZSgwLHNvdXJjZS5sYXN0SW5kZXhPZigiLyIpKTpwYXRoSW5CcmFuZChib2R5LnBhcmVudFBhdGgscm9vdCx0cnVlKTsKICBjb25zdCBuYW1lPWJvZHkub3BlcmF0aW9uPT09InJlbmFtZSI/Ym9keS5uYW1lOnNvdXJjZS5zbGljZShzb3VyY2UubGFzdEluZGV4T2YoIi8iKSsxKTsKICBpZighWyJyZW5hbWUiLCJtb3ZlIl0uaW5jbHVkZXMoYm9keS5vcGVyYXRpb24pfHx0eXBlb2YgbmFtZSE9PSJzdHJpbmcifHwhbmFtZS50cmltKCl8fG5hbWUubGVuZ3RoPjE4MHx8CiAgIC9bXC9cXFx4MDAtXHgxZl0vLnRlc3QobmFtZSl8fG5hbWU9PT0iLiJ8fG5hbWU9PT0iLi4iKXJldHVybiBqc29uKDQwMCx7b2s6ZmFsc2UsZXJyb3I6IkludmFsaWQgZm9sZGVyIG9wZXJhdGlvbi9uYW1lIn0pOwogIHRhcmdldD1wYXRoSW5CcmFuZChwYXJlbnQrIi8iK25hbWUscm9vdCk7CiAgaWYodGFyZ2V0LnRvTG93ZXJDYXNlKCk9PT1zb3VyY2UudG9Mb3dlckNhc2UoKXx8cGFyZW50LnRvTG93ZXJDYXNlKCk9PT1zb3VyY2UudG9Mb3dlckNhc2UoKXx8CiAgIHBhcmVudC50b0xvd2VyQ2FzZSgpLnN0YXJ0c1dpdGgoc291cmNlLnRvTG93ZXJDYXNlKCkrIi8iKSlyZXR1cm4ganNvbig0MDAse29rOmZhbHNlLGVycm9yOiJTZWxmIGFuZCBkZXNjZW5kYW50IG1vdmVzIGFyZSBibG9ja2VkIn0pOwogIGNsaWVudD1hd2FpdCBjb25uZWN0RGF0YWJhc2UoKTthd2FpdCBjbGllbnQucXVlcnkoIkJFR0lOIik7CiAgYXdhaXQgY2xpZW50LnF1ZXJ5KCJTRVQgTE9DQUwgbG9ja190aW1lb3V0ID0gJzVzJyIpOwogIGF3YWl0IGNsaWVudC5xdWVyeSgiU0VMRUNUIHBnX2Fkdmlzb3J5X3hhY3RfbG9jayhoYXNodGV4dGV4dGVuZGVkKCQxLDApKSIsWyJlcGUtZm9sZGVyOiIrYm9keS5icmFuZFNsdWddKTsKICBjb25zdCBicmFuZD1hd2FpdCBjbGllbnQucXVlcnkoJ1NFTEVDVCAiaWQiIEZST00gIkJyYW5kIiBXSEVSRSAic2x1ZyI9JDEgQU5EICJzdGF0dXMiPSQyJyxbYm9keS5icmFuZFNsdWcsImFjdGl2ZSJdKTsKICBpZighYnJhbmQucm93c1swXSl0aHJvdyBuZXcgRXJyb3IoIkFjdGl2ZSBicmFuZCBub3QgZm91bmQiKTsKICBjb25zdCB0b2tlbj17YnJhbmRTbHVnOmJvZHkuYnJhbmRTbHVnLGRlYWRsaW5lOkRhdGUubm93KCkrNDAwMDB9OwogIGNvbnN0IGZvbGRlcj1hd2FpdCBjYWxsKHRva2VuLCJnZXRfbWV0YWRhdGEiLHtwYXRoOnNvdXJjZX0pOwogIGlmKGZvbGRlclsiLnRhZyJdIT09ImZvbGRlciJ8fCFmb2xkZXIuaWQpdGhyb3cgbmV3IEVycm9yKCJTb3VyY2UgbXVzdCBiZSBhbiBleGlzdGluZyBmb2xkZXIiKTsKICBmb2xkZXJJZD1mb2xkZXIuaWQ7c291cmNlPXBhdGhJbkJyYW5kKGZvbGRlci5wYXRoX2Rpc3BsYXkscm9vdCk7CiAgY29uc3QgZGVzdGluYXRpb249YXdhaXQgY2FsbCh0b2tlbiwiZ2V0X21ldGFkYXRhIix7cGF0aDpwYXJlbnR9KTsKICBpZihkZXN0aW5hdGlvblsiLnRhZyJdIT09ImZvbGRlciIpdGhyb3cgbmV3IEVycm9yKCJEZXN0aW5hdGlvbiBwYXJlbnQgbXVzdCBiZSBhbiBleGlzdGluZyBmb2xkZXIiKTsKICBjb25zdCBmaWxlcz1uZXcgTWFwKCk7bGV0IGN1cnNvcixwYWdlcz0wOwogIGRvewogICBpZigrK3BhZ2VzPjIwKXRocm93IG5ldyBFcnJvcigiRm9sZGVyIGludmVudG9yeSB0b28gbGFyZ2UgZm9yIHRoaXMgb3BlcmF0aW9uOyB1c2UgdGhlIGRhc2hib2FyZCIpOwogICBjb25zdCBwYWdlPWF3YWl0IGNhbGwodG9rZW4sY3Vyc29yPyJsaXN0X2ZvbGRlci9jb250aW51ZSI6Imxpc3RfZm9sZGVyIixjdXJzb3I/e2N1cnNvcn06e3BhdGg6c291cmNlLHJlY3Vyc2l2ZTp0cnVlLGluY2x1ZGVfZGVsZXRlZDpmYWxzZSxsaW1pdDoyMDAwfSk7CiAgIGZvcihjb25zdCBlbnRyeSBvZiBwYWdlLmVudHJpZXN8fFtdKWlmKGVudHJ5WyIudGFnIl09PT0iZmlsZSImJmVudHJ5LmlkJiZlbnRyeS5wYXRoX2Rpc3BsYXk/LnRvTG93ZXJDYXNlKCkuc3RhcnRzV2l0aChzb3VyY2UudG9Mb3dlckNhc2UoKSsiLyIpKWZpbGVzLnNldChlbnRyeS5pZCxlbnRyeS5wYXRoX2Rpc3BsYXkpOwogICBjdXJzb3I9cGFnZS5oYXNfbW9yZT9wYWdlLmN1cnNvcjp1bmRlZmluZWQ7CiAgfXdoaWxlKGN1cnNvcik7CiAgY29uc3Qgc2VsZWN0ZWQ9YXdhaXQgY2xpZW50LnF1ZXJ5KGBTRUxFQ1QgImlkIiwiYnJhbmRJZCIsInNvdXJjZUZpbGVJZCIsInNvdXJjZUV4dGVybmFsSWQiLCJzb3VyY2VQYXRoIiwic291cmNlUGF0aExvd2VyIiwic291cmNlVXJsIiwic291cmNlTWV0YWRhdGEiCiAgIEZST00gIkFzc2V0IiBXSEVSRSAic291cmNlVHlwZSI9J2Ryb3Bib3gnIEFORAogICAgKCJzb3VyY2VGaWxlSWQiPUFOWSgkNDo6dGV4dFtdKSBPUiAic291cmNlRXh0ZXJuYWxJZCI9QU5ZKCQ0Ojp0ZXh0W10pIE9SCiAgICAgKCJicmFuZElkIj0kMSBBTkQgKGxlZnQobG93ZXIoY29hbGVzY2UoInNvdXJjZVBhdGgiLCcnKSksJDIpPSQzIE9SIGxlZnQobG93ZXIoY29hbGVzY2UoInNvdXJjZVVybCIsJycpKSwkMik9JDMpKSkgRk9SIFVQREFURWAsCiAgIFticmFuZC5yb3dzWzBdLmlkLHNvdXJjZS5sZW5ndGgrMSxzb3VyY2UudG9Mb3dlckNhc2UoKSsiLyIsWy4uLmZpbGVzLmtleXMoKV1dKTsKICBjb25zdCBjdXJyZW50UGF0aHM9bmV3IE1hcCgpLHNlZW5JZHM9bmV3IFNldCgpOwogIGZvcihjb25zdCBhc3NldCBvZiBzZWxlY3RlZC5yb3dzKXsKICAgaWYoYXNzZXQuYnJhbmRJZCE9PWJyYW5kLnJvd3NbMF0uaWQpdGhyb3cgbmV3IEVycm9yKCJBIGZvbGRlciBmaWxlIGlzIHJlZ2lzdGVyZWQgdW5kZXIgYW5vdGhlciBicmFuZDsgbW92ZSBzdG9wcGVkIik7CiAgIGNvbnN0IGlkcz1bYXNzZXQuc291cmNlRmlsZUlkLGFzc2V0LnNvdXJjZUV4dGVybmFsSWRdLmZpbHRlcih2PT52IT09bnVsbCYmdiE9PXVuZGVmaW5lZCYmdiE9PSIiKTsKICAgaWYoIWlkcy5sZW5ndGh8fGlkcy5zb21lKHY9PnR5cGVvZiB2IT09InN0cmluZyJ8fCF2LnN0YXJ0c1dpdGgoImlkOiIpKXx8bmV3IFNldChpZHMpLnNpemUhPT0xKXRocm93IG5ldyBFcnJvcigiQW4gYWZmZWN0ZWQgYXNzZXQgbGFja3MgYSBjb25zaXN0ZW50IERyb3Bib3ggSUQ7IG1vdmUgc3RvcHBlZCIpOwogICBpZihzZWVuSWRzLmhhcyhpZHNbMF0pKXRocm93IG5ldyBFcnJvcigiQSBmb2xkZXIgZmlsZSBoYXMgZHVwbGljYXRlIHJlZ2lzdGVyZWQgYXNzZXRzOyBtb3ZlIHN0b3BwZWQiKTsKICAgc2Vlbklkcy5hZGQoaWRzWzBdKTsKICAgY29uc3QgY3VycmVudFBhdGg9ZmlsZXMuZ2V0KGlkc1swXSk7CiAgIGlmKCFjdXJyZW50UGF0aCl0aHJvdyBuZXcgRXJyb3IoIkFuIGFmZmVjdGVkIGFzc2V0IGlzIGFic2VudCBmcm9tIHRoZSBmb2xkZXIgaW52ZW50b3J5OyByZWNvbmNpbGUgYmVmb3JlIG1vdmluZyIpOwogICBjdXJyZW50UGF0aHMuc2V0KGFzc2V0LmlkLGN1cnJlbnRQYXRoKTsKICB9CiAgY29uc3QgcmVzdWx0PWF3YWl0IGNhbGwodG9rZW4sIm1vdmVfdjIiLHtmcm9tX3BhdGg6Zm9sZGVySWQsdG9fcGF0aDp0YXJnZXQsYXV0b3JlbmFtZTpmYWxzZSxhbGxvd19zaGFyZWRfZm9sZGVyOmZhbHNlLGFsbG93X293bmVyc2hpcF90cmFuc2ZlcjpmYWxzZX0pOwogIG1vdmVkPXRydWU7CiAgaWYocmVzdWx0Lm1ldGFkYXRhPy5pZCE9PWZvbGRlcklkfHwhcmVzdWx0Lm1ldGFkYXRhLnBhdGhfZGlzcGxheSl0aHJvdyBuZXcgRXJyb3IoIk1vdmVkIGZvbGRlciBpZGVudGl0eSBub3QgdmVyaWZpZWQiKTsKICB0YXJnZXQ9cGF0aEluQnJhbmQocmVzdWx0Lm1ldGFkYXRhLnBhdGhfZGlzcGxheSxyb290KTsKICBmb3IoY29uc3QgYXNzZXQgb2Ygc2VsZWN0ZWQucm93cyl7CiAgIGNvbnN0IG5ld1BhdGg9cmVsb2NhdGUoY3VycmVudFBhdGhzLmdldChhc3NldC5pZCksc291cmNlLHRhcmdldCk7CiAgIGNvbnN0IGRhdGE9YXNzZXQuc291cmNlTWV0YWRhdGEmJnR5cGVvZiBhc3NldC5zb3VyY2VNZXRhZGF0YT09PSJvYmplY3QiP3suLi5hc3NldC5zb3VyY2VNZXRhZGF0YX06e307CiAgIGZvcihjb25zdCBrZXkgb2YgWyJwYXRoIiwicGF0aF9kaXNwbGF5IiwicGF0aF9sb3dlciJdKWlmKHR5cGVvZiBkYXRhW2tleV09PT0ic3RyaW5nIilkYXRhW2tleV09a2V5PT09InBhdGhfbG93ZXIiP25ld1BhdGgudG9Mb3dlckNhc2UoKTpuZXdQYXRoOwogICBhd2FpdCBjbGllbnQucXVlcnkoYFVQREFURSAiQXNzZXQiIFNFVCAic291cmNlUGF0aCI9JDIsInNvdXJjZVBhdGhMb3dlciI9JDMsInNvdXJjZVVybCI9JDQsInNvdXJjZU1ldGFkYXRhIj0kNTo6anNvbmIsInVwZGF0ZWRBdCI9Q1VSUkVOVF9USU1FU1RBTVAgV0hFUkUgImlkIj0kMWAsCiAgICBbYXNzZXQuaWQsdHlwZW9mIGFzc2V0LnNvdXJjZVBhdGg9PT0ic3RyaW5nIj9uZXdQYXRoOm51bGwsdHlwZW9mIGFzc2V0LnNvdXJjZVBhdGhMb3dlcj09PSJzdHJpbmciP25ld1BhdGgudG9Mb3dlckNhc2UoKTpudWxsLAogICAgIHR5cGVvZiBhc3NldC5zb3VyY2VVcmw9PT0ic3RyaW5nIiYmYXNzZXQuc291cmNlVXJsLnN0YXJ0c1dpdGgoIi8iKT9uZXdQYXRoOmFzc2V0LnNvdXJjZVVybCxKU09OLnN0cmluZ2lmeShkYXRhKV0pOwogIH0KICBjb21taXRTdGFydGVkPXRydWU7YXdhaXQgY2xpZW50LnF1ZXJ5KCJDT01NSVQiKTsKICByZXR1cm4ganNvbigyMDAse29rOnRydWUsZHJvcGJveEZvbGRlcklkOmZvbGRlcklkLHByZXZpb3VzUGF0aDpzb3VyY2UscGF0aDp0YXJnZXQsYXNzZXRzU3luY2hyb25pemVkOnNlbGVjdGVkLnJvd3MubGVuZ3RoLAogICBub3RlOiJGb2xkZXIgSUQgYW5kIGZpbGUgSURzIHByZXNlcnZlZDsgYXNzZXQgd29ya2Zsb3cgc3RhdHVzZXMgdW5jaGFuZ2VkIn0pOwogfWNhdGNoKGVycm9yKXsKICB1bmNlcnRhaW5Nb3ZlPWVycm9yLnVuY2VydGFpbk1vdmU9PT10cnVlOwogIGNvbnNvbGUuZXJyb3IoIltjbGF1ZGUtZm9sZGVyXSBmYWlsZWQiLHttZXNzYWdlOmVycm9yLm1lc3NhZ2UsdW5jZXJ0YWluTW92ZX0pOwogIGlmKGNsaWVudClhd2FpdCBjbGllbnQucXVlcnkoIlJPTExCQUNLIikuY2F0Y2goKCk9Pnt9KTsKICBsZXQgcmVzdG9yZWQ9ZmFsc2U7CiAgLy8gQSBsb3N0IENPTU1JVCByZXNwb25zZSBpcyBhbWJpZ3VvdXMuIERvIG5vdCBjb21wZW5zYXRlIGluIHRoYXQgY2FzZS4KICBpZihtb3ZlZCYmIWNvbW1pdFN0YXJ0ZWQpe3RyeXtjb25zdCByPWF3YWl0IGNhbGwoe2JyYW5kU2x1Zzpib2R5LmJyYW5kU2x1ZyxkZWFkbGluZTpEYXRlLm5vdygpKzEyMDAwfSwibW92ZV92MiIse2Zyb21fcGF0aDpmb2xkZXJJZCx0b19wYXRoOnNvdXJjZSxhdXRvcmVuYW1lOmZhbHNlLGFsbG93X3NoYXJlZF9mb2xkZXI6ZmFsc2UsYWxsb3dfb3duZXJzaGlwX3RyYW5zZmVyOmZhbHNlfSk7cmVzdG9yZWQ9ci5tZXRhZGF0YT8uaWQ9PT1mb2xkZXJJZDt9Y2F0Y2h7fX0KICByZXR1cm4ganNvbigobW92ZWQmJiFyZXN0b3JlZCl8fHVuY2VydGFpbk1vdmU/MjAwOjQwOSx7b2s6ZmFsc2UscmVjb25jaWxpYXRpb25SZXF1aXJlZDoobW92ZWQmJiFyZXN0b3JlZCl8fHVuY2VydGFpbk1vdmUsbW92ZVJvbGxlZEJhY2s6cmVzdG9yZWQsCiAgIC4uLihmb2xkZXJJZD97ZHJvcGJveEZvbGRlcklkOmZvbGRlcklkLHByZXZpb3VzUGF0aDpzb3VyY2UsZGVzdGluYXRpb25QYXRoOnRhcmdldH06e30pLAogICBlcnJvcjplcnJvciBpbnN0YW5jZW9mIEVycm9yP2Vycm9yLm1lc3NhZ2U6IkZvbGRlciBvcGVyYXRpb24gZmFpbGVkIiwKICAgLi4uKChtb3ZlZCYmIXJlc3RvcmVkKXx8dW5jZXJ0YWluTW92ZT97bWVzc2FnZToiRHJvcGJveCBtYXkgaGF2ZSBtb3ZlZCB0aGUgZm9sZGVyLiBEbyBub3QgcmV0cnkgdGhlIG1vdmU7IHJlY29uY2lsZSB0aGlzIGZvbGRlciBJRCBhbmQgcmVnaXN0ZXJlZCBwYXRocy4ifTp7fSl9KTsKIH1maW5hbGx5e2lmKGNsaWVudClhd2FpdCBjbGllbnQuZW5kKCkuY2F0Y2goKCk9Pnt9KTt9Cn0KZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJlcGFpckNsYXVkZVRlc3RTdGF0dXMoY29ubmVjdERhdGFiYXNlLGpzb24pewogbGV0IGNsaWVudDsKIHRyeXsKICBjbGllbnQ9YXdhaXQgY29ubmVjdERhdGFiYXNlKCk7YXdhaXQgY2xpZW50LnF1ZXJ5KCJCRUdJTiIpOwogIGNvbnN0IHJlc3VsdD1hd2FpdCBjbGllbnQucXVlcnkoYFNFTEVDVCBhLiJpZCIsYS4idGl0bGUiLGEuInRhZ3MiLGEuImluZ2VzdFN0YXR1cyIsYS4iYXBwcm92YWxTdGF0dXMiLGIuInNsdWciIEZST00gIkFzc2V0IiBhCiAgIEpPSU4gIkJyYW5kIiBiIE9OIGIuImlkIj1hLiJicmFuZElkIiBXSEVSRSBhLiJpZCI9JDEgRk9SIFVQREFURSBPRiBhYCxbIjAxZTI1NTMxLWI0M2MtNDc4Zi05M2ZhLTlhOWY2NWEyZWU4OSJdKTsKICBjb25zdCBhc3NldD1yZXN1bHQucm93c1swXTsKICBpZighYXNzZXR8fGFzc2V0LnNsdWchPT0iZWxldHRybyJ8fGFzc2V0LnRpdGxlIT1udWxsfHxhc3NldC5hcHByb3ZhbFN0YXR1cyE9PSJhcHByb3ZlZCJ8fAogICAhQXJyYXkuaXNBcnJheShhc3NldC50YWdzKXx8YXNzZXQudGFncy5sZW5ndGh8fCFbInJhdyIsIm5lZWRzX21ldGFkYXRhIl0uaW5jbHVkZXMoYXNzZXQuaW5nZXN0U3RhdHVzKSkKICAgdGhyb3cgbmV3IEVycm9yKCJUZXN0IGFzc2V0IG5vIGxvbmdlciBtYXRjaGVzIHRoZSByZWNvcmRlZCBzdGF0ZTsgcmVwYWlyIHN0b3BwZWQiKTsKICBjb25zdCBjaGFuZ2VkPWFzc2V0LmluZ2VzdFN0YXR1cyE9PSJyYXciOwogIGlmKGNoYW5nZWQpYXdhaXQgY2xpZW50LnF1ZXJ5KCdVUERBVEUgIkFzc2V0IiBTRVQgImluZ2VzdFN0YXR1cyI9JDI6OiJJbmdlc3RTdGF0dXMiLCJ1cGRhdGVkQXQiPUNVUlJFTlRfVElNRVNUQU1QIFdIRVJFICJpZCI9JDEnLFthc3NldC5pZCwicmF3Il0pOwogIGF3YWl0IGNsaWVudC5xdWVyeSgiQ09NTUlUIik7cmV0dXJuIGpzb24oMjAwLHtvazp0cnVlLGFzc2V0SWQ6YXNzZXQuaWQsaW5nZXN0U3RhdHVzOiJyYXciLGNoYW5nZWQsCiAgIG5vdGU6Ik9ubHkgdGhlIGRvY3VtZW50ZWQgaW5nZXN0U3RhdHVzIHNpZGUgZWZmZWN0IHdhcyByZXBhaXJlZDsgZW5yaWNobWVudFN0YXR1cyB3YXMgbm90IGd1ZXNzZWQifSk7CiB9Y2F0Y2goZXJyb3Ipe2lmKGNsaWVudClhd2FpdCBjbGllbnQucXVlcnkoIlJPTExCQUNLIikuY2F0Y2goKCk9Pnt9KTtyZXR1cm4ganNvbig0MDkse29rOmZhbHNlLGVycm9yOmVycm9yLm1lc3NhZ2V9KTt9CiBmaW5hbGx5e2lmKGNsaWVudClhd2FpdCBjbGllbnQuZW5kKCkuY2F0Y2goKCk9Pnt9KTt9Cn0K'

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
