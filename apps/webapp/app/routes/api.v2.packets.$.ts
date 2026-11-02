import { createPacketUploadRoute } from "~/services/packetApi.server";

const { action, loader } = createPacketUploadRoute();
export { action, loader };
