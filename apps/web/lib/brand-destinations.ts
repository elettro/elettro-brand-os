import { brandConfigs } from "./brand-config";
import { publishingDestinations, type PublishingDestinationId } from "./publishing-destinations";

export type BrandDestination = {
 id: string;
 brandId: string;
 channel: PublishingDestinationId;
 label: string;
 endpointUrl?: string;
 connectionStatus: "unconfigured" | "connected" | "disabled";
 publishingMode: "direct" | "syndication" | "link_only";
};
export const brandDestinationRegistry: BrandDestination[] = [
 {id:"stashbox-website",brandId:"stashbox",channel:"website",label:"Stashbox.com",connectionStatus:"unconfigured",publishingMode:"direct"},
 {id:"stashbox-radio-blog",brandId:"stashbox",channel:"website",label:"Stashbox Radio Blog",connectionStatus:"unconfigured",publishingMode:"direct"},
 {id:"solarmeister-store",brandId:"solarmeister",channel:"shopify",label:"SolarMeister Shop",connectionStatus:"unconfigured",publishingMode:"direct"},
 {id:"solarmeister-blog",brandId:"solarmeister",channel:"shopify",label:"SolarMeister Blog",connectionStatus:"unconfigured",publishingMode:"direct"},
 {id:"solarmeister-ratgeber",brandId:"solarmeister",channel:"shopify",label:"SolarMeister Ratgeber",connectionStatus:"unconfigured",publishingMode:"direct"}
];
export function destinationsForBrand(brandId:string):BrandDestination[] {
 if(!brandConfigs.some(brand=>brand.id===brandId))return [];
 const known=brandDestinationRegistry.filter(d=>d.brandId===brandId);
 const channelsWithEntries=new Set(known.map(d=>d.channel));
 return [...known,...publishingDestinations.filter(d=>!channelsWithEntries.has(d.id)).map(d=>({
   id:`${brandId}-${d.id}`,brandId,channel:d.id,label:d.label,
   connectionStatus:"unconfigured" as const,publishingMode:d.kind==="feed"?"syndication" as const:"direct" as const
 }))];
}
export function isReadyToPublish(destination:BrandDestination):boolean {
 return destination.connectionStatus==="connected" && !!destination.endpointUrl;
}
