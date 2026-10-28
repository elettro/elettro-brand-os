# Elettro AR tools for ChatGPT, Claude Code and Claude web

Seven MCP tools on the existing `/api/mcp` gateway let an AI client build AR experiences as **drafts**. The OS pages
(AR > Experiences, QR codes) show the result. **No tool publishes**: publishing a set (which makes its images and videos public)
stays a button in Elettro OS until Dean decides otherwise. `ar_publish_set` exists in `apps/web/lib/ar-gateway-core.ts` and is
tested, but is not listed as a tool (the gateway's existing tests and `docs/ai-gateway-v1.md` rule out publishing tools).

| Tool | Permission | What it does |
|---|---|---|
| `elettro_ar_overview` | `ar:read` | Covers (what each does), actions, scan sets, QR codes with addresses |
| `elettro_ar_prepare_upload` | `ar:write` | Short-lived PUT link for a cover (JPEG/PNG) or an MP4; returns a `key` |
| `elettro_ar_add_cover` | `ar:write` | Attached file (ChatGPT) or `imageKey` -> compiled tracking files + a **draft** cover |
| `elettro_ar_add_action` | `ar:write` | A video overlay (`videoKey`) or a link button (label + https url) |
| `elettro_ar_connect` | `ar:write` | Which actions fire, in order, when a cover is scanned |
| `elettro_ar_add_to_set` | `ar:write` | Add covers to a scan set (create it by name if new) |
| `elettro_ar_set_qr` | `ar:write` | Create a QR code, or repoint one (takes effect for everyone who scans the printed code) |

Every write needs `confirmed: true`, like the other gateway mutations. Brand scope comes from the client's credential, as for the other tools.

## Typical flow
- **ChatGPT:** attach the cover, say what it should do. `elettro_ar_add_cover` reads the attached file from its approved temporary link, stores it, and compiles it.
  A video goes through `elettro_ar_prepare_upload` (kind `video`), then the MP4 is PUT to the returned link (ChatGPT cannot PUT bytes, so videos
  from ChatGPT need Claude Code or the OS for now; links, QR changes and everything else work).
- **Claude Code:** `elettro_ar_prepare_upload`, `curl -X PUT` the file to the returned link with the returned headers, then `elettro_ar_add_cover` / `elettro_ar_add_action` with the `key`.
- Then check the draft in the OS and **Publish set** there.

## Turning it on (AWS, by Dean; nothing here is automatic)
1. Merge the AR API compile PR first and deploy the new Lambda (`POST /ar/brands/<brand>/triggers/compile`), see its PR for the memory/timeout change.
2. In the SSM parameter that holds the MCP client list (the `ELETTRO_AI_MCP_CLIENTS_JSON` value named in `apps/web/lib/ai-mcp-auth.ts`), add `"ar:read"` and `"ar:write"` to the `permissions` of each client that should use AR
   (and the AR brands to its `brandSlugs`). Do not paste the file anywhere; it contains token hashes. Clients that are not edited are unaffected.
3. In Amplify, make sure `AR_API_BASE_URL` is set (see the AR console PR).
