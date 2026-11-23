import { readFileSync } from "node:fs";

export function adminCredentials(origin, username = "aoki") {
  const password = readFileSync(new URL("../.runtime/admin-accounts/" + username, import.meta.url), "utf8").trim();
  return { username, password, origin };
}

export function adminHeader(origin) {
  const { username, password } = adminCredentials(origin);
  return "Basic " + Buffer.from(username + ":" + password).toString("base64");
}
