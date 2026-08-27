// agent/store.js — persistance simple des leads (fichier JSON)
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "data");
const LEADS_FILE = join(DATA_DIR, "leads.json");

export async function loadLeads() {
  try {
    const raw = await readFile(LEADS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function saveLead(lead) {
  await mkdir(DATA_DIR, { recursive: true });
  const leads = await loadLeads();
  const record = { ...lead, createdAt: new Date().toISOString() };
  leads.push(record);
  await writeFile(LEADS_FILE, JSON.stringify(leads, null, 2));
  return record;
}
