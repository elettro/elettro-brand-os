// Lambda entry point: wires relay.mjs to DynamoDB and the API Gateway WebSocket management API.
// The AWS SDK v3 clients come with the nodejs24.x Lambda runtime, so the zip has no node_modules.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, GetCommand, QueryCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';
import { makeHandler } from './relay.mjs';

const TABLE = process.env.RELAY_TABLE || 'elettro-scroll-dev';
const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const extraOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);

const db = {
  put: (item) => doc.send(new PutCommand({ TableName: TABLE, Item: item })),
  get: async (key) => (await doc.send(new GetCommand({ TableName: TABLE, Key: key }))).Item,
  query: async (pk) => (await doc.send(new QueryCommand({
    TableName: TABLE, KeyConditionExpression: 'pk = :p', ExpressionAttributeValues: { ':p': pk },
  }))).Items || [],
  del: (key) => doc.send(new DeleteCommand({ TableName: TABLE, Key: key })),
};

let mgmt = null;
let handle = null;

export async function handler(event) {
  // the management endpoint is built from the request's own domain + stage, so no config is needed
  const { domainName, stage } = event.requestContext;
  if (!mgmt) mgmt = new ApiGatewayManagementApiClient({ endpoint: `https://${domainName}/${stage}` });
  if (!handle) {
    handle = makeHandler({
      db,
      extraOrigins,
      post: async (cid, data) => { await mgmt.send(new PostToConnectionCommand({ ConnectionId: cid, Data: data })); },
    });
  }
  return handle(event);
}
