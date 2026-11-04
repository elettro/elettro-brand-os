import test from "node:test";
import assert from "node:assert/strict";
import {dropboxCredentials} from "../services/dev-api-lambda/dropbox-identity.mjs";

test("reads snake_case secret keys", () => {
  const c = dropboxCredentials({access_token:"a",app_key:"k",app_secret:"s",refresh_token:"r"});
  assert.deepEqual(c, {accessToken:"a",appKey:"k",appSecret:"s",refreshToken:"r"});
});
test("still reads camelCase secret keys", () => {
  const c = dropboxCredentials({accessToken:"a",appKey:"k",appSecret:"s",refreshToken:"r"});
  assert.deepEqual(c, {accessToken:"a",appKey:"k",appSecret:"s",refreshToken:"r"});
});
test("missing keys stay undefined and empty config is safe", () => {
  assert.equal(dropboxCredentials({}).refreshToken, undefined);
  assert.equal(dropboxCredentials().appKey, undefined);
});
