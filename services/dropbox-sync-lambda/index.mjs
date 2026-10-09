import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";

const secrets = new SecretsManagerClient({});
const lambda = new LambdaClient({});

const DROPBOX_ROOT = "/1---elettro-brand-os";

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

async function dropboxList(token, cursor) {
  const endpoint = cursor ? "files/list_folder/continue" : "files/list_folder";
  const body = cursor
    ? { cursor }
    : {
        path: DROPBOX_ROOT,
        recursive: true,
        include_deleted: false,
        include_non_downloadable_files: false,
        limit: 100
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
  try {
    const token = await getDropboxToken();
    const cursor = event.cursor || null;
    const listing = await dropboxList(token, cursor);

    const files = (listing.entries || []).filter((entry) => entry[".tag"] === "file");
    const writer = await invokeWriter(files, listing);

    return json(200, {
      ok: true,
      message: "Dropbox page fetched and handed to DB writer",
      received: listing.entries?.length || 0,
      filesSent: files.length,
      indexed: writer.indexed ?? null,
      skipped: writer.skipped ?? null,
      hasMore: Boolean(listing.has_more),
      cursor: listing.cursor || null
    });
  } catch (error) {
    console.error("[dropbox-sync] failed", error);
    return json(500, {
      ok: false,
      error: error instanceof Error ? error.message : "Unknown Dropbox sync error"
    });
  }
};
