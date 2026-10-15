// Text returned to an MCP client for a failed tool call. A wrong-brand lookup
// names the asset's real brand only when the caller is already authorized for
// that brand; otherwise the generic "not found" is returned unchanged.
export function mcpErrorText(error:{message:string;actualBrandSlug?:unknown},allowedBrandSlugs:readonly string[]):string{
 const brand=error.actualBrandSlug;
 if(typeof brand!=="string"||!allowedBrandSlugs.includes(brand))return error.message;
 return error.message+". This asset is registered under brand \""+brand+
  "\"; retry with brandSlug \""+brand+"\".";
}
