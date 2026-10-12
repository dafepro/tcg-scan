import type {
  AppData,
  Card,
  CollectionEntry,
  Condition,
  DeckLine,
  Finish,
  Game,
} from "../types";
export const MAX_QUANTITY = 9999;
export function normalizeName(name: string) {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}
export function addToCollection(
  collection: CollectionEntry[],
  card: Card,
  quantity: number,
  condition: Condition,
  finish: Finish,
): CollectionEntry[] {
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY)
    throw new Error("Quantity must be a whole number from 1 to 9,999.");
  const match = collection.find(
    (entry) =>
      entry.card.id === card.id &&
      entry.card.game === card.game &&
      entry.condition === condition &&
      entry.finish === finish &&
      !entry.verification &&
      !entry.scanEventId,
  );
  if (match && match.quantity + quantity > MAX_QUANTITY)
    throw new Error("This entry would exceed 9,999 cards.");
  return match
    ? collection.map((entry) =>
        entry.id === match.id
          ? { ...entry, quantity: entry.quantity + quantity, card }
          : entry,
      )
    : [
        {
          id: crypto.randomUUID(),
          card,
          quantity,
          condition,
          finish,
          addedAt: new Date().toISOString(),
          notes: "",
        },
        ...collection,
      ];
}
export function referenceTotals(collection: CollectionEntry[]) {
  const totals = { USD: 0, EUR: 0, priced: 0, unpriced: 0 };
  for (const entry of collection) {
    const price =
      entry.verification === "identity-only"
        ? undefined
        : (entry.card.prices.find((p) => p.currency === "USD") ??
          entry.card.prices.find((p) => p.currency === "EUR"));
    if (price) {
      totals[price.currency] += price.amount * entry.quantity;
      totals.priced += entry.quantity;
    } else totals.unpriced += entry.quantity;
  }
  return totals;
}
export function parseDeck(text: string): {
  lines: DeckLine[];
  warnings: string[];
} {
  const lines = new Map<string, DeckLine>();
  const warnings: string[] = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (
      !line ||
      line.startsWith("//") ||
      line.startsWith("#") ||
      /^(deck|commander|mainboard|sideboard|maybeboard|main deck|extra deck|side deck):?$/i.test(
        line,
      )
    )
      return;
    const match =
      line.match(/^(\d+)\s*x?\s+(.+)$/i) ?? line.match(/^(\d+)x\s*(.+)$/i);
    const name = (match?.[2] ?? line)
      .replace(/\s+\([A-Za-z0-9]+\)\s+\S+\s*$/, "")
      .trim();
    const quantity = match ? Number(match[1]) : 1;
    if (
      !name ||
      !Number.isSafeInteger(quantity) ||
      quantity < 1 ||
      quantity > MAX_QUANTITY
    ) {
      warnings.push(
        `Line ${index + 1}: use a quantity from 1 to 9,999 followed by a card name.`,
      );
      return;
    }
    const key = normalizeName(name);
    const existing = lines.get(key);
    if ((existing?.quantity ?? 0) + quantity > MAX_QUANTITY) {
      warnings.push(`Line ${index + 1}: combined quantity exceeds 9,999.`);
      return;
    }
    lines.set(key, {
      name: existing?.name ?? name,
      quantity: (existing?.quantity ?? 0) + quantity,
    });
  });
  return { lines: [...lines.values()], warnings };
}
export function checkDeck(
  text: string,
  game: Game,
  collection: CollectionEntry[],
) {
  const parsed = parseDeck(text);
  return {
    warnings: parsed.warnings,
    lines: parsed.lines.map((line) => {
      const owned = collection
        .filter(
          (entry) =>
            entry.card.game === game &&
            normalizeName(entry.card.name) === normalizeName(line.name),
        )
        .reduce((sum, entry) => sum + entry.quantity, 0);
      return { ...line, owned, missing: Math.max(0, line.quantity - owned) };
    }),
  };
}
function csvCell(value: unknown) {
  let text = String(value ?? "");
  if (/^[=+\-@\t\r\n＝＋－＠]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}
export function collectionCsv(collection: CollectionEntry[]) {
  const rows: unknown[][] = [
    [
      "Game",
      "Name",
      "Set",
      "Set code",
      "Number",
      "Quantity",
      "Condition",
      "Finish",
      "Reference amount",
      "Currency",
      "Price source",
      "Price retrieved/updated",
      "Notes",
      "Printing verification",
      "Matched reference set",
      "Matched reference number",
      "Read catalog set",
      "Read catalog number",
      "Catalog identifiers read at",
      "Still unconfirmed",
    ],
  ];
  for (const entry of collection) {
    const price =
      entry.verification === "identity-only"
        ? undefined
        : (entry.card.prices.find((p) => p.currency === "USD") ??
          entry.card.prices[0]);
    rows.push([
      entry.card.game,
      entry.card.name,
      entry.verification === "identity-only" ? "" : entry.card.setName,
      entry.verification === "identity-only" ? "" : entry.card.setCode,
      entry.verification === "identity-only" ? "" : entry.card.number,
      entry.quantity,
      entry.condition,
      entry.finish,
      price?.amount ?? "",
      price?.currency ?? "",
      price?.source ?? "",
      price?.updatedAt ?? "",
      entry.notes,
      entry.verification === "identity-only" ? "Unconfirmed" : "User confirmed",
      entry.verification === "identity-only" ? entry.card.setName : "",
      entry.verification === "identity-only" ? entry.card.number : "",
      entry.printingRead?.setName ?? "",
      entry.printingRead?.number ?? "",
      entry.printingRead?.readAt ?? "",
      entry.printingRead?.unconfirmed.join("; ") ?? "",
    ]);
  }
  return "\uFEFF" + rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
}
export function backupJson(data: AppData) {
  // Use the same compact representation and byte budget as persistence/import.
  const serialized = JSON.stringify(data);
  if (new TextEncoder().encode(serialized).byteLength > 10_000_000)
    throw new Error("Backup exceeds the 10 MB import limit.");
  return serialized;
}

export function downloadFile(content: BlobPart, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
