/**
 * Real DynamoDB / S3 / CloudFront implementations of the interfaces `app.mjs` expects.
 * AWS SDK v3 is provided by the Lambda runtime (the other Lambdas ship only their own code), and it is imported
 * lazily so unit tests never need it.
 */

export async function createDynamoStore({ table }) {
  const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
  const { DynamoDBDocumentClient, QueryCommand, GetCommand, PutCommand, DeleteCommand, UpdateCommand } = await import("@aws-sdk/lib-dynamodb");
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
  const pk = (brand) => `BRAND#${brand}`;
  return {
    async list(brand) {
      const out = [];
      let ExclusiveStartKey;
      do {
        const r = await doc.send(new QueryCommand({ TableName: table, KeyConditionExpression: "PK = :p", ExpressionAttributeValues: { ":p": pk(brand) }, ExclusiveStartKey }));
        out.push(...(r.Items || []));
        ExclusiveStartKey = r.LastEvaluatedKey;
      } while (ExclusiveStartKey);
      return out;
    },
    async get(brand, sk) {
      const r = await doc.send(new GetCommand({ TableName: table, Key: { PK: pk(brand), SK: sk } }));
      return r.Item || null;
    },
    async put(brand, sk, data) {
      await doc.send(new PutCommand({ TableName: table, Item: { ...data, PK: pk(brand), SK: sk } }));
    },
    async del(brand, sk) {
      await doc.send(new DeleteCommand({ TableName: table, Key: { PK: pk(brand), SK: sk } }));
    },    /** Atomic counters: ADD each field in `inc`, SET each in `set`, and SET each in `setIfMissing` only the first time. */
    async add(brand, sk, { inc = {}, set = {}, setIfMissing = {} }) {
      const names = {}, values = {}, adds = [], sets = [];
      let i = 0;
      for (const [f, n] of Object.entries(inc)) { names["#a" + i] = f; values[":a" + i] = n; adds.push("#a" + i + " :a" + i); i++; }
      for (const [f, val] of Object.entries(set)) { names["#s" + i] = f; values[":s" + i] = val; sets.push("#s" + i + " = :s" + i); i++; }
      for (const [f, val] of Object.entries(setIfMissing)) { names["#m" + i] = f; values[":m" + i] = val; sets.push("#m" + i + " = if_not_exists(#m" + i + ", :m" + i + ")"); i++; }
      const expr = [adds.length ? "ADD " + adds.join(", ") : "", sets.length ? "SET " + sets.join(", ") : ""].filter(Boolean).join(" ");
      await doc.send(new UpdateCommand({ TableName: table, Key: { PK: pk(brand), SK: sk }, UpdateExpression: expr, ExpressionAttributeNames: names, ExpressionAttributeValues: values }));
    }
  };
}

export async function createFiles({ bucket }) {
  const { S3Client, PutObjectCommand, HeadObjectCommand, GetObjectCommand } = await import("@aws-sdk/client-s3");
  const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
  const s3 = new S3Client({});
  return {
    async presignPut({ key, contentType }) {
      const url = await getSignedUrl(s3, new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType }), { expiresIn: 600 });
      return { url };
    },
    async head(key) {
      try {
        const r = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return { size: Number(r.ContentLength || 0), contentType: r.ContentType };
      } catch (e) {
        if (e?.$metadata?.httpStatusCode === 404 || e?.name === "NotFound") return null;
        throw e;
      }
    },
    async getJson(key) {
      try {
        const r = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        return JSON.parse(await r.Body.transformToString());
      } catch (e) {
        if (e?.name === "NoSuchKey" || e?.$metadata?.httpStatusCode === 404) return null;
        throw e;
      }
    },
    async putJson(key, obj) {
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: JSON.stringify(obj), ContentType: "application/json", CacheControl: "public, max-age=60" }));
    },
    async getBuffer(key) {
      const r = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      return Buffer.from(await r.Body.transformToByteArray());
    },
    async putBuffer(key, buffer, contentType) {
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: buffer, ContentType: contentType, CacheControl: "public, max-age=300" }));
    }
  };
}

export async function createCdn({ distributionId }) {
  if (!distributionId) return { async invalidate() {} }; // not set up yet: manifests still update, caches just expire (60 s)
  const { CloudFrontClient, CreateInvalidationCommand } = await import("@aws-sdk/client-cloudfront");
  const cf = new CloudFrontClient({});
  return {
    async invalidate(paths) {
      await cf.send(new CreateInvalidationCommand({ DistributionId: distributionId, InvalidationBatch: { CallerReference: `ar-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, Paths: { Quantity: paths.length, Items: paths } } }));
    }
  };
}
