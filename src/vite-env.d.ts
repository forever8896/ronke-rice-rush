/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Ronin Stash's Privy app id; empty turns email login off. */
  readonly VITE_STASH_APP_ID?: string;
}
