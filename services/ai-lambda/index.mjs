import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { handleEvent, LIMITS } from "./converse.mjs";

const client = new BedrockRuntimeClient({ region: process.env.AWS_REGION || "us-east-1", maxAttempts: 2 });
const send = (input) => client.send(new ConverseCommand(input), { abortSignal: AbortSignal.timeout(LIMITS.timeoutMs) });

export const handler = (event) => handleEvent(event, send);
