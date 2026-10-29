import { createAuthClient } from "better-auth/react";

// Talks to the existing /api/auth/* handler on the same origin.
export const authClient = createAuthClient();
