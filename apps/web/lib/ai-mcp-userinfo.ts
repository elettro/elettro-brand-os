/**
 * Cognito UserInfo returns email_verified as the string "true" or "false"
 * (rather than a JSON boolean). Keep owner checks fail-closed.
 */
export function isVerifiedCognitoOwner(
 user:Record<string,unknown>,
 subject:string,
 expectedEmail:string
):boolean{
 return user.sub===subject &&
  typeof user.email==="string" &&
  user.email.toLowerCase()===expectedEmail.toLowerCase() &&
  (user.email_verified===true || user.email_verified==="true");
}
