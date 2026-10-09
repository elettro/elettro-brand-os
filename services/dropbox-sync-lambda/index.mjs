import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";

const secrets = new SecretsManagerClient({});
const lambda = new LambdaClient({});

const DROPBOX_ROOT = "/1---elettro-brand-os";
const MAX_RUNTIME_MS = 22000;
const PAGE_LIMIT = 500;

function json(statusCode, body) {
  return { statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

async function getDropboxToken() {
  const secretId = process.env.DROPBOX_SECRET_NAME;
  if (!secretId) throw new Error("DROPBOX_SECRET_NAME is not configured");
  const result = await secrets.send(new GetSecretValueCommand({ SecretId: secretId }));
  if (!result.SecretString) throw new Error("Dropbox secret has no SecretString");
  const config = JSON.parse(result.SecretString);
  if (!config.accessToken) throw new Error("Dropbox secret does not contain accessToken");
  return config.accessToken;
}

async function dropboxThumbnail(token, path, kind = "image") {
  if (!path || typeof path !== "string" || !path.toLowerCase().startsWith(DROPBOX_ROOT)) {
    return {
      statusCode: 400,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ok: false, error: "Invalid Dropbox asset path" })
    };
  }

  if (kind === "video") {
    const response = await fetch("https://api.dropboxapi.com/2/files/get_temporary_link", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ path })
    });

    const payload = await response.json();
    if (!response.ok || !payload.link) {
      return {
        statusCode: response.status === 409 ? 404 : response.status,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
        body: JSON.stringify({ ok: false, error: "Video preview unavailable", detail: payload })
      };
    }

    return {
      statusCode: 302,
      headers: {
        location: payload.link,
        "cache-control": "private, max-age=240"
      },
      body: ""
    };
  }

  const response = await fetch("https://content.dropboxapi.com/2/files/get_thumbnail_v2", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "dropbox-api-arg": JSON.stringify({
        resource: { ".tag": "path", path },
        format: { ".tag": "jpeg" },
        size: { ".tag": "w640h480" },
        mode: { ".tag": "bestfit" }
      })
    }
  });

  if (!response.ok) {
    const detail = await response.text();
    return {
      statusCode: response.status === 409 ? 404 : response.status,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
      body: JSON.stringify({ ok: false, error: "Thumbnail unavailable", detail })
    };
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  return {
    statusCode: 200,
    headers: {
      "content-type": "image/jpeg",
      "cache-control": "private, max-age=300"
    },
    isBase64Encoded: true,
    body: bytes.toString("base64")
  };
}

async function dropboxList(token, cursor) {
  const endpoint = cursor ? "files/list_folder/continue" : "files/list_folder";
  const body = cursor
    ? { cursor }
    : {
        path: DROPBOX_ROOT,
        recursive: true,
        include_deleted: false,
        include_non_downloadable_files: false,
        limit: PAGE_LIMIT
      };

  const response = await fetch(`https://api.dropboxapi.com/2/${endpoint}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(`Dropbox ${endpoint} failed: ${response.status} ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function invokeWriter(entries, listing) {
  const functionName = process.env.DB_WRITER_FUNCTION_NAME;
  if (!functionName) throw new Error("DB_WRITER_FUNCTION_NAME is not configured");

  const payload = {
    action: "ingest-dropbox-page",
    entries,
    cursor: listing.cursor || null,
    hasMore: Boolean(listing.has_more),
    accountRef: "dropbox"
  };

  const result = await lambda.send(
    new InvokeCommand({
      FunctionName: functionName,
      InvocationType: "RequestResponse",
      Payload: Buffer.from(JSON.stringify(payload))
    })
  );

  const raw = result.Payload ? Buffer.from(result.Payload).toString("utf8") : "";
  const response = raw ? JSON.parse(raw) : {};

  if (result.FunctionError) {
    throw new Error(`DB writer Lambda failed: ${raw}`);
  }

  const writerBody =
    typeof response.body === "string"
      ? JSON.parse(response.body)
      : response.body || response;

  if (response.statusCode && response.statusCode >= 400) {
    throw new Error(`DB writer returned ${response.statusCode}: ${JSON.stringify(writerBody)}`);
  }

  return writerBody;
}

export const handler = async (event = {}) => {
  const startedAt = Date.now();

  try {
    const token = await getDropboxToken();

    const requestPath =
      event?.rawPath ||
      event?.requestContext?.http?.path ||
      event?.path ||
      "";

    if (requestPath === "/dropbox/thumbnail") {
      const sourcePath =
        event?.queryStringParameters?.path ||
        event?.queryStringParameters?.sourcePath ||
        "";
      const kind = event?.queryStringParameters?.kind || "image";
      return await dropboxThumbnail(token, sourcePath, kind);
    }

    let cursor = event.cursor || null;
    let pagesProcessed = 0;
    let received = 0;
    let filesSent = 0;
    let indexed = 0;
    let skipped = 0;
    let hasMore = true;

    while (hasMore && Date.now() - startedAt < MAX_RUNTIME_MS) {
      const listing = await dropboxList(token, cursor);
      pagesProcessed += 1;
      received += listing.entries?.length || 0;

      const files = (listing.entries || []).filter((entry) => entry[".tag"] === "file");
      filesSent += files.length;

      const writer = await invokeWriter(files, listing);
      indexed += Number(writer.indexed || 0);
      skipped += Number(writer.skipped || 0);

      cursor = listing.cursor || null;
      hasMore = Boolean(listing.has_more);

      if (!hasMore) break;
    }

    return json(200, {
      ok: true,
      message: hasMore
        ? "Dropbox sync paused before timeout; run again to continue from saved cursor"
        : "Dropbox sync completed",
      pagesProcessed,
      received,
      filesSent,
      indexed,
      skipped,
      hasMore,
      cursor
    });
  } catch (error) {
    console.error("[dropbox-sync] failed", error);
    return json(500, {
      ok: false,
      error: error instanceof Error ? error.message : "Unknown Dropbox sync error"
    });
  }
};
