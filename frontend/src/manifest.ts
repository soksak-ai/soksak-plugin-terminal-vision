// plugin.json is the one copy; TypeScript reads the file the host loads.
import declared from "../../plugin.json" with { type: "json" };

export const manifest = declared;
