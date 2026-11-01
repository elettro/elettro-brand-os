import { MULTICAM_BRANDS, MULTICAM_PUBLIC_ORIGIN } from "@/lib/multicam";
import { MultiCamHost } from "./multicam-host";

export const metadata = { title: "MultiCam · Elettro OS" };

export default function MultiCamPage() {
  return <MultiCamHost brands={MULTICAM_BRANDS} publicOrigin={MULTICAM_PUBLIC_ORIGIN} />;
}
