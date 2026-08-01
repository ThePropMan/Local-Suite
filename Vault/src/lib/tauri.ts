// ============================================================
// Vault — lib/tauri.ts
// App-specific invoke wrappers for the Rust vault commands.
// Generalized Tauri helpers live in ../shared/lib/tauri.
// ============================================================

import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "../shared/lib/tauri";

export { isTauri };
export type { Theme } from "../shared/types";

export interface VaultEntry {
  id: string;
  title: string;
  username: string;
  password: string;
  url: string | null;
  notes: string | null;
  folder: string | null;
  tags: string[];
  created: number;
  modified: number;
}

export interface GenOptions {
  length?: number;
  useUppercase?: boolean;
  useLowercase?: boolean;
  useDigits?: boolean;
  useSymbols?: boolean;
  excludeAmbiguous?: boolean;
}

/** Check if a vault file exists on disk. */
export async function vaultExists(): Promise<boolean> {
  if (!isTauri) return false;
  return invoke<boolean>("vault_exists");
}

/** Create a new empty vault with a master password. */
export async function createVault(masterPassword: string): Promise<void> {
  return invoke<void>("create_vault", { masterPassword });
}

/** Unlock the vault with a master password. */
export async function unlockVault(masterPassword: string): Promise<void> {
  return invoke<void>("unlock_vault", { masterPassword });
}

/** Lock the vault (zeroize key and entries from memory). */
export async function lockVault(): Promise<void> {
  return invoke<void>("lock_vault");
}

/** Check if the vault is currently unlocked. */
export async function isUnlocked(): Promise<boolean> {
  if (!isTauri) return false;
  return invoke<boolean>("is_unlocked");
}

/** Get all entries (only while unlocked). */
export async function getEntries(): Promise<VaultEntry[]> {
  return invoke<VaultEntry[]>("get_entries");
}

/** Add or update an entry, then re-encrypt and save. */
export async function saveEntry(entry: VaultEntry): Promise<void> {
  return invoke<void>("save_entry", { entry });
}

/** Delete an entry by ID. */
export async function deleteEntry(id: string): Promise<void> {
  return invoke<void>("delete_entry", { id });
}

/** Generate a random password. */
export async function generatePassword(opts: GenOptions): Promise<string> {
  return invoke<string>("generate_password", {
    length: opts.length ?? null,
    useUppercase: opts.useUppercase ?? null,
    useLowercase: opts.useLowercase ?? null,
    useDigits: opts.useDigits ?? null,
    useSymbols: opts.useSymbols ?? null,
    excludeAmbiguous: opts.excludeAmbiguous ?? null,
  });
}

/** Estimate password strength in bits of entropy. */
export async function estimateStrength(password: string): Promise<number> {
  return invoke<number>("estimate_strength", { password });
}

/** Change the master password. */
export async function changeMasterPassword(
  oldPassword: string,
  newPassword: string,
): Promise<void> {
  return invoke<void>("change_master_password", {
    oldPassword,
    newPassword,
  });
}

/** Export all entries to a string (json or csv). */
export async function exportVault(format: "json" | "csv"): Promise<string> {
  return invoke<string>("export_vault", { format });
}

/** Import entries from a string (json or csv). Returns count imported. */
export async function importVault(data: string, format: "json" | "csv"): Promise<number> {
  return invoke<number>("import_vault", { data, format });
}

/** Copy text to clipboard (uses Tauri clipboard plugin). */
export async function copyToClipboard(text: string): Promise<void> {
  if (isTauri) {
    const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
    await writeText(text);
  } else {
    await navigator.clipboard.writeText(text);
  }
}

/** Clear the clipboard. */
export async function clearClipboard(): Promise<void> {
  if (isTauri) {
    const { clear } = await import("@tauri-apps/plugin-clipboard-manager");
    await clear();
  }
}
