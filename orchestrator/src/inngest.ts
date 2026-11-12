import { Inngest } from "inngest";

// Talks to the self-hosted server through INNGEST_BASE_URL, INNGEST_DEV=0 and the two keys.
export const inngest = new Inngest({ id: "software-factory" });
