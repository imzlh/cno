import { Request } from "./request";
import { Response } from "./response";
import { fetch } from "./perform";
import { XMLHttpRequest } from "./xhr";

export * from "./helpers";
export * from "./request";
export * from "./response";
export * from "./perform";
export * from "./xhr";
// `get/setResponseInitiatorCallFrames` come from `./response` above and
// `truncateHookPostData` from `./helpers`; only the 101 builder moved out.
export { createSwitchingProtocolsResponse } from "./server-response";

Reflect.set(globalThis, "fetch", fetch);
Reflect.set(globalThis, "Response", Response);
Reflect.set(globalThis, "Request", Request);
Reflect.set(globalThis, "XMLHttpRequest", XMLHttpRequest);
