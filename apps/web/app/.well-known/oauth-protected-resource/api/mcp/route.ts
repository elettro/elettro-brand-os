// RFC 9728 path-aware discovery for the protected /api/mcp resource.
// Reuses the same fail-closed, owner-configured metadata as the root
// well-known URL advertised in the WWW-Authenticate challenge.
export {GET, runtime, dynamic} from "@/app/.well-known/oauth-protected-resource/route";
