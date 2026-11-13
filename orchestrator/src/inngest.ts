import { Inngest } from "inngest";

// The unit sets FACTORY_NAME from its instance name. One factory serves one repo, one Inngest app each.
const FACTORY_NAME_RULE = /^[a-z][a-z0-9-]{0,20}$/;
export const FACTORY_NAME = process.env.FACTORY_NAME ?? "";
if (!FACTORY_NAME_RULE.test(FACTORY_NAME)) {
  throw new Error(`FACTORY_NAME must match ${FACTORY_NAME_RULE}, got ${JSON.stringify(FACTORY_NAME)}. Start the factory-orchestrator@<name> unit.`);
}

// Talks to the self-hosted server through INNGEST_BASE_URL, INNGEST_DEV=0 and the two keys.
export const inngest = new Inngest({ id: `software-factory-${FACTORY_NAME}` });

/** Every event name. Factories share one Inngest server, so a name without the factory would start runs in every factory. */
export const ev = (event: string) => `factory/${FACTORY_NAME}/${event}`;

/** Where Inngest, in its container, calls this factory. */
export const serveOrigin = (port: number) => `http://host.docker.internal:${port}`;
