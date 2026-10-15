import test from "node:test";
import assert from "node:assert/strict";
import {approvedChatGptFileHost} from "../apps/web/lib/ai-mcp-file-hosts.ts";

test("accept ChatGPT attachments from both observed Azure regions",()=>{
 for(const host of [
  "oaisdmntprcentralus.blob.core.windows.net",
  "oaisdmntprnorthcentralus.blob.core.windows.net",
  "oaisdmntpreastus.blob.core.windows.net",
  "oaisdmntpreastus2.blob.core.windows.net",
  "OAISDMNTPRNORTHCENTRALUS.BLOB.CORE.WINDOWS.NET"
 ])assert.equal(approvedChatGptFileHost(host),true,host);
});

test("preserve OpenAI-owned traditional attachment hosts",()=>{
 for(const host of [
  "chatgpt.com","files.oaiusercontent.com","foo.oaiusercontent.com"
 ])assert.equal(approvedChatGptFileHost(host),true,host);
});

test("reject arbitrary Azure accounts, subdomain tricks, and unobserved regional accounts",()=>{
 for(const host of [
  "evil.blob.core.windows.net",
  "oaisdmntprwestus.blob.core.windows.net",
  "oaisdmntprnorthcentralus.blob.core.windows.net.evil.example",
  "oaisdmntprnorthcentralus.blob.core.windows.net.evil.oaiusercontent.example",
  "x.oaisdmntprnorthcentralus.blob.core.windows.net",
  "oaisdmntprnorthcentralus.blob.core.windows.net.attacker.com",
  "oaisdmntprnorthcentralus.blob.core.windows.netx",
  "oaiusercontent.com.evil.example",
  "oaiusercontent.com",
  "blob.core.windows.net"
 ])assert.equal(approvedChatGptFileHost(host),false,host);
});
