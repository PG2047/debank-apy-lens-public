import { PUBLIC_RPC } from './rpc-config';

// Public builds always use keyless defaults. Set personal RPC URLs in the popup.
export const DEFAULT_RPC: Record<number, string> = { ...PUBLIC_RPC };
