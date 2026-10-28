import { arCall, ArNotConfigured, AR_PUBLIC_BASE } from "@/lib/ar-api";
import { brandConfigs } from "@/lib/brand-config";
import { approvedChatGptFileHost } from "@/lib/ai-mcp-file-hosts";
import { GatewayError } from "@/lib/ai-gateway";
import { ArToolError, executeArAction, type ArDeps } from "@/lib/ar-gateway-core";

// Real I/O for the AR gateway tools: the AR API (server-side, connect key), a ChatGPT file link, and a presigned S3 upload.
const fetchFile: ArDeps["fetchFile"] = async (url, maxBytes) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(25000), redirect: "error" });
  if (!response.ok) throw new ArToolError(502, "Could not read the attached file");
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > maxBytes) throw new ArToolError(413, "That file is too large for a cover");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > maxBytes) throw new ArToolError(413, "That file is too large for a cover");
  return bytes;
};

const putFile: ArDeps["putFile"] = async (url, headers, bytes) => {
  const response = await fetch(url, { method: "PUT", headers, body: bytes as unknown as BodyInit, signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new ArToolError(502, "The cover could not be stored");
};

export async function executeArTool(args: Record<string, unknown>, action: string, clientId: string): Promise<Record<string, unknown>> {
  const deps: ArDeps = {
    brands: brandConfigs.map((b) => b.id),
    publicBase: AR_PUBLIC_BASE,
    call: (path, init) => arCall(path, { ...init, actor: `mcp:${clientId}` }),
    allowedFileHost: (url) => approvedChatGptFileHost(url.hostname),
    fetchFile,
    putFile
  };
  try {
    return await executeArAction(action, args, deps);
  } catch (error) {
    if (error instanceof ArNotConfigured) throw new GatewayError(503, "AR is not connected to this environment yet");
    if (error instanceof ArToolError) throw new GatewayError(error.status, error.problems?.length ? `${error.message}: ${error.problems.join("; ")}` : error.message);
    const e = error as { status?: number; problems?: string[]; message?: string };
    if (typeof e.status === "number") throw new GatewayError(e.status === 404 ? 404 : e.status >= 500 ? 502 : 400, e.problems?.length ? `${e.message}: ${e.problems.join("; ")}` : e.message || "The AR service did not accept that");
    throw error;
  }
}
