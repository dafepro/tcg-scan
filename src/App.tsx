import { useEffect, useId, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUpFromLine,
  BookOpen,
  Check,
  ChevronRight,
  CircleHelp,
  ClipboardCheck,
  Copy,
  Download,
  ExternalLink,
  FolderOpen,
  Grid2X2,
  Layers3,
  List,
  LoaderCircle,
  Minus,
  Plus,
  ScanLine,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import Scanner from "./components/Scanner";
import ContinuousScanner from "./components/ContinuousScanner";
import { ReferenceQuotes } from "./components/ReferenceQuotes";
import {
  addScanEvent,
  undoScanEvent,
  refineScanPrinting,
} from "./lib/scan-inventory";
import type { ReferenceMetadata } from "./lib/vision";
import CardImage from "./components/CardImage";
import { getCard, searchCards } from "./lib/catalog";
import {
  addToCollection,
  backupJson,
  checkDeck,
  collectionCsv,
  downloadFile,
  referenceTotals,
} from "./lib/collection";
import {
  loadData,
  mergeBackup,
  parseBackup,
  saveData,
  STORAGE_KEY,
} from "./lib/storage";
import { CONDITIONS, FINISHES, GAME_LABELS, GAME_SHORT } from "./types";
import type {
  AppData,
  Card,
  CollectionEntry,
  Condition,
  Deck,
  Finish,
  Game,
  ReviewItem,
} from "./types";
import "./components/scanner.css";

type SetAppData = (next: AppData | ((current: AppData) => AppData)) => boolean;
type View = "scan" | "review" | "collection" | "decks";
const nav = [
  { id: "scan", label: "Scan", icon: ScanLine },
  { id: "review", label: "Review", icon: ClipboardCheck },
  { id: "collection", label: "Collection", icon: Layers3 },
  { id: "decks", label: "Deck checker", icon: BookOpen },
] as const;
const money = (value: number, currency = "USD") =>
  new Intl.NumberFormat("en-US", { style: "currency", currency }).format(value);
const dateLabel = (value: string) =>
  new Date(value).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
function Price({ card }: { card: Card }) {
  const p = card.prices.find((p) => p.currency === "USD") ?? card.prices[0];
  return (
    <span className={`price ${p ? "" : "muted"}`}>
      {p ? money(p.amount, p.currency) : "No price"}
    </span>
  );
}
function Source({ card }: { card: Card }) {
  const p = card.prices.find((p) => p.currency === "USD") ?? card.prices[0];
  return (
    <div className="source-note">
      <a href={card.sourceUrl} target="_blank" rel="noreferrer">
        {card.provider}
        <ExternalLink size={11} />
      </a>
      {p && (
        <span>
          {p.source} · {dateLabel(p.updatedAt)}
          {p.note ? ` · ${p.note}` : ""}
        </span>
      )}
    </div>
  );
}

export default function App() {
  const [initial] = useState(loadData);
  const [data, commitData] = useState<AppData>(initial.data);
  const dataRef = useRef(initial.data);
  const [storageWarning, setStorageWarning] = useState(initial.warning);
  const storageConflict = useRef(false);
  const storageSnapshot = useRef<string | null | undefined>(undefined);
  const [view, setView] = useState<View>("scan");
  const [game, setGame] = useState<Game>("pokemon");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Card[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [selecting, setSelecting] = useState<string | null>(null);
  const [origin, setOrigin] = useState<"search" | "scan">("search");
  const [notice, setNotice] = useState("");
  const [showHelp, setShowHelp] = useState(false);
  const searchController = useRef<AbortController | null>(null);
  const selectController = useRef<AbortController | null>(null);
  const queryInput = useRef<HTMLInputElement>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const [pendingImport, setPendingImport] = useState<AppData | null>(null);
  const [importError, setImportError] = useState("");
  const setData: SetAppData = (next) => {
    try {
      const candidate =
        typeof next === "function" ? next(dataRef.current) : next;
      const validated = parseBackup(JSON.stringify(candidate));
      dataRef.current = validated;
      commitData(validated);
      return true;
    } catch (error) {
      setNotice((error as Error).message);
      return false;
    }
  };
  function durableScanChange(next: AppData): string | undefined {
    if (initial.warning || storageConflict.current)
      return "Saving is paused to protect your collection. Export and reload before scanning.";
    try {
      const current = localStorage.getItem(STORAGE_KEY);
      if (
        storageSnapshot.current !== undefined &&
        current !== storageSnapshot.current
      ) {
        storageConflict.current = true;
        setStorageWarning(
          "Another tab changed this collection. Saving is paused; export and reload.",
        );
        return "Another tab changed your collection. Scan was not saved.";
      }
      const validated = parseBackup(JSON.stringify(next));
      const warning = saveData(validated);
      if (warning) {
        setStorageWarning(warning);
        return "Storage is full or blocked. Scan was not saved. Export your collection and free space.";
      }
      storageSnapshot.current = JSON.stringify(validated);
      dataRef.current = validated;
      commitData(validated);
      return undefined;
    } catch (error) {
      return error instanceof Error
        ? error.message
        : "Could not save this scan.";
    }
  }
  function saveScan(reference: ReferenceMetadata, eventId: string) {
    return durableScanChange({
      ...dataRef.current,
      collection: addScanEvent(dataRef.current.collection, reference, eventId),
    });
  }
  function refinePrinting(
    eventId: string,
    resolution: import("./lib/printing-refinement").PrintingResolution,
  ) {
    const collection = refineScanPrinting(
      dataRef.current.collection,
      eventId,
      resolution,
    );
    if (collection === dataRef.current.collection)
      return "The original saved scan is no longer available for this printing update.";
    return durableScanChange({ ...dataRef.current, collection });
  }
  function undoScan(eventId: string) {
    return durableScanChange({
      ...dataRef.current,
      collection: undoScanEvent(dataRef.current.collection, eventId),
    });
  }
  const totalCards = data.collection.reduce((n, e) => n + e.quantity, 0);
  const totals = referenceTotals(data.collection);
  useEffect(() => {
    if (initial.warning || storageConflict.current) return;
    try {
      const current = localStorage.getItem(STORAGE_KEY);
      if (
        storageSnapshot.current !== undefined &&
        current !== storageSnapshot.current
      ) {
        storageConflict.current = true;
        setStorageWarning(
          "Another tab changed this collection. Saving is paused to protect both versions. Export your work, then reload this page.",
        );
        return;
      }
      const warning = saveData(data);
      setStorageWarning(warning);
      if (!warning) storageSnapshot.current = JSON.stringify(data);
    } catch {
      setStorageWarning(
        "Storage is unavailable. Export your work before closing this page.",
      );
    }
  }, [data, initial.warning]);
  useEffect(() => {
    const listener = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY || event.key === null) {
        storageConflict.current = true;
        setStorageWarning(
          "Another tab changed this collection. Saving is paused to protect both versions. Export your work, then reload this page.",
        );
      }
    };
    window.addEventListener("storage", listener);
    return () => window.removeEventListener("storage", listener);
  }, []);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 6000);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(
    () => () => {
      searchController.current?.abort();
      selectController.current?.abort();
    },
    [],
  );
  function changeGame(next: Game) {
    searchController.current?.abort();
    selectController.current?.abort();
    setSearching(false);
    setSelecting(null);
    setGame(next);
    setResults([]);
    setSearchError("");
    setSearched(false);
    setQuery("");
  }
  async function runSearch(value = query, from: "search" | "scan" = "search") {
    const term = value.trim();
    if (term.length < 2) {
      setSearchError("Enter at least 2 characters, or a card ID.");
      return;
    }
    searchController.current?.abort();
    const controller = new AbortController();
    searchController.current = controller;
    setQuery(term);
    setOrigin(from);
    setSearching(true);
    setSearched(false);
    setSearchError("");
    setResults([]);
    try {
      const cards = await searchCards(game, term, controller.signal);
      if (!controller.signal.aborted) {
        setResults(cards);
        setSearched(true);
      }
    } catch (error) {
      if (!controller.signal.aborted)
        setSearchError(
          error instanceof Error
            ? error.message
            : "Search unavailable. Please try again.",
        );
    } finally {
      if (!controller.signal.aborted) setSearching(false);
    }
  }
  async function chooseCard(card: Card) {
    if (selecting) return;
    const controller = new AbortController();
    selectController.current = controller;
    setSelecting(card.id);
    setSearchError("");
    try {
      if (data.review.length >= 1000)
        throw new Error(
          "Review queue is full. Confirm or discard cards before adding more.",
        );
      const detail = await getCard(card.game, card.id, controller.signal);
      if (controller.signal.aborted) return;
      const item: ReviewItem = {
        id: crypto.randomUUID(),
        card: detail,
        origin,
        addedAt: new Date().toISOString(),
      };
      if (!setData((old) => ({ ...old, review: [...old.review, item] })))
        return;
      setNotice(`${detail.name} is ready to review.`);
    } catch (error) {
      if (!controller.signal.aborted)
        setSearchError(
          error instanceof Error ? error.message : "Could not load this card.",
        );
    } finally {
      if (!controller.signal.aborted) setSelecting(null);
    }
  }
  function confirmCard(
    item: ReviewItem,
    quantity: number,
    condition: Condition,
    finish: Finish,
  ) {
    try {
      const collection = addToCollection(
        data.collection,
        item.card,
        quantity,
        condition,
        finish,
      );
      const updated = {
        ...data,
        collection,
        review: data.review.filter((r) => r.id !== item.id),
      };
      parseBackup(JSON.stringify(updated));
      if (!setData(updated)) return;
      setNotice(`${quantity} × ${item.card.name} added to your collection.`);
    } catch (error) {
      setNotice((error as Error).message);
    }
  }
  async function readImport(file: File | undefined) {
    if (!file) return;
    try {
      if (file.size > 10_000_000)
        throw new Error("Choose a JSON backup smaller than 10 MB.");
      setImportError("");
      setPendingImport(parseBackup(await file.text()));
    } catch (error) {
      setNotice((error as Error).message);
    } finally {
      if (importInput.current) importInput.current.value = "";
    }
  }
  function exportBackup() {
    downloadFile(
      backupJson(data),
      `tcg-scan-backup-${new Date().toISOString().slice(0, 10)}.json`,
      "application/json",
    );
    setNotice("JSON backup downloaded. Keep it somewhere safe.");
  }
  return (
    <>
      <header className="topbar">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setView("scan");
          }}
          aria-label="tcg scan home"
        >
          <span className="brand-mark">
            <ScanLine size={23} />
          </span>
          <span>
            tcg<span className="brand-light"> scan</span>
            <small>THE COLLECTOR'S TOOLKIT</small>
          </span>
        </a>
        <nav className="main-nav" aria-label="Main navigation">
          {nav.map((n) => (
            <button
              key={n.id}
              className={view === n.id ? "nav-link active" : "nav-link"}
              aria-current={view === n.id ? "page" : undefined}
              onClick={() => setView(n.id)}
            >
              <n.icon size={17} />
              <span>{n.label}</span>
              {n.id === "review" && data.review.length > 0 && (
                <b className="count">{data.review.length}</b>
              )}
            </button>
          ))}
        </nav>
        <div className="header-actions">
          <span className="local-label">
            <span />
            Local-first
          </span>
          <button
            className="icon-button"
            aria-label="Data and privacy"
            onClick={() => setShowHelp(true)}
          >
            <CircleHelp size={20} />
          </button>
        </div>
      </header>
      {storageWarning && (
        <div className="storage-warning" role="alert">
          {storageWarning}
          <button onClick={exportBackup}>Export backup</button>
        </div>
      )}
      <main className="app-main">
        {view === "scan" && (
          <>
            <section className="page-heading scan-heading">
              <div>
                <p className="eyebrow">
                  <span /> A HOME FOR EVERY CARD
                </p>
                <h1>
                  Your next great find.
                  <br /> <span>Already in focus.</span>
                </h1>
                <p className="page-intro">Scan locally. Keep collecting.</p>
              </div>
              <div className="hero-stat">
                <Layers3 size={22} />
                <strong>{totalCards.toLocaleString()}</strong>
                <span>cards in your collection</span>
                <button onClick={() => setView("collection")}>
                  Open collection
                  <ArrowRight size={14} />
                </button>
              </div>
            </section>
            <div className="workspace-heading">
              <div
                className="game-tabs"
                role="group"
                aria-label="Choose card game"
              >
                {(Object.keys(GAME_LABELS) as Game[]).map((g) => (
                  <button
                    key={g}
                    onClick={() => changeGame(g)}
                    aria-pressed={game === g}
                    className={game === g ? "selected" : ""}
                  >
                    <span className={`game-dot ${g}`} />
                    {GAME_SHORT[g]}
                  </button>
                ))}
              </div>
              <span className="quiet-label">
                <ShieldCheck size={14} /> Your photos stay on your device
              </span>
            </div>
            <div className="scan-workspace">
              <div className="scan-main-column">
                <ContinuousScanner
                  key={game}
                  game={game}
                  onSave={saveScan}
                  onUndo={undoScan}
                  onPrinting={refinePrinting}
                />
                <details className="assisted-scan">
                  <summary>
                    Assisted photo / text scan · for cards outside your local
                    packs
                  </summary>
                  <Scanner
                    key={game}
                    game={game}
                    onRecognized={(text) => void runSearch(text, "scan")}
                    onManualSearch={() => queryInput.current?.focus()}
                  />
                </details>
              </div>
              <aside className="search-panel panel">
                <div className="panel-heading">
                  <div>
                    <span className="eyebrow">FIND YOUR CARD</span>
                    <h2>Card lookup</h2>
                  </div>
                  <Search size={20} />
                </div>
                <p className="section-description">
                  Fallback lookup for uncovered or ambiguous cards. Live
                  scanning uses your installed local reference packs.
                </p>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void runSearch();
                  }}
                >
                  <label className="sr-only" htmlFor="catalog-search">
                    Card name or ID
                  </label>
                  <div className="search-input">
                    <Search size={18} />
                    <input
                      ref={queryInput}
                      id="catalog-search"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder={
                        game === "pokemon"
                          ? "Try “Pikachu” or “base1-58”"
                          : game === "mtg"
                            ? "Try “Lightning Bolt”"
                            : "Try “Dark Magician”"
                      }
                      maxLength={150}
                    />
                    <button
                      type="submit"
                      aria-label="Search catalog"
                      disabled={searching}
                    >
                      {searching ? (
                        <LoaderCircle size={17} className="spin" />
                      ) : (
                        <ArrowRight size={18} />
                      )}
                    </button>
                  </div>
                </form>
                {searchError && (
                  <p className="error-message" role="alert">
                    {searchError}
                  </p>
                )}
                {searching && (
                  <div className="search-loading" role="status">
                    <LoaderCircle className="spin" size={24} />
                    <span>Searching {GAME_SHORT[game]} cards…</span>
                  </div>
                )}
                {!searching && !searched && !searchError && (
                  <div className="lookup-empty">
                    <div className="mini-card-stack">
                      <span />
                      <span />
                      <span>
                        <Sparkles size={27} />
                      </span>
                    </div>
                    <h3>Find the one in your hand.</h3>
                    <p>
                      Names and card IDs work best.
                      <br />
                      You’ll confirm every match before saving.
                    </p>
                    <div className="suggestions">
                      {(game === "pokemon"
                        ? ["Pikachu", "Charizard"]
                        : game === "mtg"
                          ? ["Lightning Bolt", "Sol Ring"]
                          : ["Dark Magician", "Blue-Eyes"]
                      ).map((q) => (
                        <button key={q} onClick={() => void runSearch(q)}>
                          {q}
                          <ChevronRight size={12} />
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {searched && !searching && (
                  <>
                    <div className="results-label">
                      {results.length
                        ? `${results.length} possible ${results.length === 1 ? "match" : "matches"}`
                        : "No cards found"}
                      <span>Confirm the printing</span>
                    </div>
                    {results.length === 0 ? (
                      <div className="empty-inline">
                        <Search size={28} />
                        <p>
                          Try a shorter name, check the spelling, or switch card
                          games.
                        </p>
                      </div>
                    ) : (
                      <div className="search-results">
                        {results.map((card) => (
                          <button
                            className="search-result"
                            key={card.id}
                            onClick={() => void chooseCard(card)}
                            disabled={selecting !== null}
                            aria-label={`Review ${card.name}, ${card.setName || card.setCode}`}
                          >
                            <CardImage card={card} />
                            <span className="result-copy">
                              <strong>{card.name}</strong>
                              <small>
                                {card.setName || card.setCode}{" "}
                                {card.number && `· #${card.number}`}
                              </small>
                              <Price card={card} />
                            </span>
                            <span className="result-add">
                              {selecting === card.id ? (
                                <LoaderCircle className="spin" size={17} />
                              ) : (
                                <Plus size={17} />
                              )}
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </>
                )}
                {data.review.length > 0 && (
                  <button
                    className="review-callout"
                    onClick={() => setView("review")}
                  >
                    <ClipboardCheck size={18} />
                    <span>
                      {data.review.length}{" "}
                      {data.review.length === 1 ? "card" : "cards"} ready to
                      review
                    </span>
                    <ArrowRight size={17} />
                  </button>
                )}
                <div className="provider-footnote">
                  {game === "pokemon"
                    ? "Catalog by TCGdex"
                    : game === "mtg"
                      ? "Catalog by Scryfall"
                      : "Catalog by YGOPRODeck · artwork omitted per provider policy"}
                  . Catalog searches use the internet.
                </div>
              </aside>
            </div>
            <div className="workflow-cards">
              <div>
                <span className="step-number">01</span>
                <div>
                  <h3>Bring your cards into focus</h3>
                  <p>Good light, separated cards, all four edges visible.</p>
                </div>
              </div>
              <div>
                <span className="step-number">02</span>
                <div>
                  <h3>Strong matches save locally</h3>
                  <p>Review unconfirmed printing, finish and condition.</p>
                </div>
              </div>
              <div>
                <span className="step-number">03</span>
                <div>
                  <h3>Keep your collection yours</h3>
                  <p>No account. Local storage. Export any time.</p>
                </div>
              </div>
            </div>
          </>
        )}
        {view === "review" && (
          <>
            <PageHeading
              eyebrow="ONE LAST LOOK"
              title="Check your finds."
              description="Confirm assisted search and OCR finds here. Strong continuous-camera matches save directly as unconfirmed identities."
              action={
                <button
                  className="button secondary"
                  onClick={() => setView("scan")}
                >
                  <Plus size={16} /> Find more cards
                </button>
              }
            />
            {data.review.length === 0 ? (
              <EmptyState
                icon={ClipboardCheck}
                title="All caught up."
                description="Assisted search and OCR finds wait here for your approval. Automatic visual matches are already in Collection."
                action="Find your first card"
                onAction={() => setView("scan")}
              />
            ) : (
              <div className="review-grid">
                {data.review.map((item) => (
                  <ReviewCard
                    key={item.id}
                    item={item}
                    onConfirm={(q, c, f) => confirmCard(item, q, c, f)}
                    onRemove={() =>
                      setData((d) => ({
                        ...d,
                        review: d.review.filter((r) => r.id !== item.id),
                      }))
                    }
                  />
                ))}
              </div>
            )}
          </>
        )}
        {view === "collection" && (
          <CollectionView
            data={data}
            setData={setData}
            totals={totals}
            totalCards={totalCards}
            onScan={() => setView("scan")}
            onExport={exportBackup}
            onImport={() => importInput.current?.click()}
            notify={setNotice}
          />
        )}
        {view === "decks" && (
          <DeckView data={data} setData={setData} notify={setNotice} />
        )}
      </main>
      <footer className="site-footer">
        <span className="footer-brand">
          <ScanLine size={15} />
          tcg scan<span>Made for the joy of collecting.</span>
        </span>
        <button onClick={() => setShowHelp(true)}>
          Open source. Always yours.
          <ArrowUpFromLine size={13} />
        </button>
      </footer>
      <input
        type="file"
        accept=".json,application/json"
        className="sr-only"
        ref={importInput}
        aria-label="Import JSON backup"
        onChange={(e) => void readImport(e.target.files?.[0])}
      />
      {notice && (
        <div className="toast" role="status">
          <Check size={18} />
          <span>{notice}</span>
          <button
            aria-label="Dismiss notification"
            onClick={() => setNotice("")}
          >
            <X size={15} />
          </button>
        </div>
      )}
      {showHelp && (
        <Modal
          title="Your cards. Your data."
          onClose={() => setShowHelp(false)}
        >
          <div className="privacy-lead">
            <ShieldCheck size={30} />
            <p>
              tcg scan is an independent, open-source toolkit. You don’t need an
              account to start collecting.
            </p>
          </div>
          <div className="help-sections">
            <section>
              <h3>Local photos, online catalogs</h3>
              <p>
                Camera frames and uploaded photos are processed on your device.
                Visual matching uses installed local reference packs. Recognized
                IDs are sent to the selected provider for automatic market
                quotes; printing refinement and assisted searches send names or
                IDs. OCR loads its English model from this site. Learned vision
                models also load only from this site and run locally. Reference
                artwork loads from approved provider hosts. Your collection
                stays in this browser.
              </p>
            </section>
            <section>
              <h3>Visual identity, unconfirmed printing</h3>
              <p>
                Continuous scanning uses local learned features and geometric
                verification, with an ORB compatibility mode. Strong stable
                identities can save automatically, with unknown condition and
                finish. Exact printing stays unconfirmed and is excluded from
                value totals. Glare, sleeves, overlapping cards and similar
                artwork can confuse recognition. Coverage is limited to loaded
                references. Assisted OCR still requires confirmation.
              </p>
            </section>
            <section>
              <h3>Prices are reference snapshots</h3>
              <p>
                Provider prices can be missing or stale. Values are not adjusted
                for your card’s condition, finish, grading, or fees. USD and EUR
                are kept separate. A missing price is never counted as zero
                market value.
              </p>
            </section>
            <section>
              <h3>Make a backup</h3>
              <p>
                Clearing site data or switching devices won’t carry your
                collection over. Export JSON to preserve cards, your review
                queue and decks. CSV is for spreadsheets and is not a restore
                format. Imported backups merge by entry ID; existing entries
                win.
              </p>
              <button className="button secondary" onClick={exportBackup}>
                <Download size={16} /> Export full backup
              </button>
            </section>
            <section>
              <h3>Independent & open source</h3>
              <p>
                Original MIT-licensed code. Not affiliated with Quickdraw, The
                Pokémon Company, Wizards of the Coast, Konami, or data
                providers. Card names and artwork belong to their respective
                owners.
              </p>
              <a
                className="text-link"
                href="https://github.com/dafepro/tcg-scan"
                target="_blank"
                rel="noreferrer"
              >
                View source on GitHub
                <ExternalLink size={14} />
              </a>
            </section>
          </div>
        </Modal>
      )}
      {pendingImport && (
        <Modal
          title="Import this backup?"
          onClose={() => setPendingImport(null)}
        >
          {importError && (
            <p className="error-message" role="alert">
              {importError}
            </p>
          )}
          <p>
            This backup contains {pendingImport.collection.length} collection
            entries, {pendingImport.review.length} cards to review, and{" "}
            {pendingImport.decks.length} saved decks.
          </p>
          <p>
            New entries will be added to this browser. Existing entries with the
            same ID remain unchanged. Importing the same backup again won’t
            duplicate its entries.
          </p>
          <div className="modal-actions">
            <button
              className="button secondary"
              onClick={() => setPendingImport(null)}
            >
              Cancel
            </button>
            <button
              className="button primary"
              onClick={() => {
                try {
                  const merged = mergeBackup(data, pendingImport);
                  if (!setData(merged)) return;
                  setPendingImport(null);
                  setNotice(
                    "Backup imported. Your existing entries were kept.",
                  );
                } catch (error) {
                  setImportError((error as Error).message);
                }
              }}
            >
              Import backup
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

function PageHeading({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string;
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <section className="page-heading">
      <div>
        <p className="eyebrow">
          <span />
          {eyebrow}
        </p>
        <h1>{title}</h1>
        <p className="page-intro">{description}</p>
      </div>
      {action}
    </section>
  );
}
function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  onAction,
}: {
  icon: typeof Layers3;
  title: string;
  description: string;
  action: string;
  onAction: () => void;
}) {
  return (
    <div className="empty-state panel">
      <div className="empty-icon">
        <Icon size={38} />
      </div>
      <h2>{title}</h2>
      <p>{description}</p>
      <button className="button primary" onClick={onAction}>
        {action}
        <ArrowRight size={16} />
      </button>
    </div>
  );
}
function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    const previousFocus = document.activeElement;
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected)
        previousFocus.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="modal"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-heading">
        <h2 id={titleId}>{title}</h2>
        <button
          className="icon-button"
          onClick={onClose}
          aria-label="Close dialog"
        >
          <X size={20} />
        </button>
      </div>
      <div className="modal-content">{children}</div>
    </dialog>
  );
}
function ReviewCard({
  item,
  onConfirm,
  onRemove,
}: {
  item: ReviewItem;
  onConfirm: (q: number, c: Condition, f: Finish) => void;
  onRemove: () => void;
}) {
  const [quantity, setQuantity] = useState(1);
  const [condition, setCondition] = useState<Condition>("Near mint");
  const [finish, setFinish] = useState<Finish>("Normal");
  return (
    <article className="review-card panel">
      <div className="review-card-top">
        <span className="tag">{GAME_SHORT[item.card.game]}</span>
        <button
          className="icon-button"
          aria-label={`Discard ${item.card.name}`}
          onClick={onRemove}
        >
          <X size={17} />
        </button>
      </div>
      <div className="review-card-content">
        <CardImage card={item.card} />
        <div>
          <p className="eyebrow">
            {item.origin === "scan" ? "SCAN CANDIDATE" : "CATALOG PICK"}
          </p>
          <h2>{item.card.name}</h2>
          <p className="muted">
            {item.card.setName} · {item.card.number || "No printing number"}
          </p>
          <span className="rarity">
            {item.card.rarity || "Rarity unavailable"}
          </span>
          <div className="review-price">
            <Price card={item.card} />
            <span>reference price</span>
          </div>
          <Source card={item.card} />
        </div>
      </div>
      {item.card.game === "yugioh" && (
        <p className="inline-warning">
          This catalog entry may cover several printings. Reference prices may
          be the lowest across versions.
        </p>
      )}
      <div className="review-controls">
        <label>
          Quantity
          <input
            type="number"
            min="1"
            max="9999"
            value={quantity}
            onChange={(e) => setQuantity(Number(e.target.value))}
          />
        </label>
        <label>
          Condition
          <select
            value={condition}
            onChange={(e) => setCondition(e.target.value as Condition)}
          >
            {CONDITIONS.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
        <label>
          Finish
          <select
            value={finish}
            onChange={(e) => setFinish(e.target.value as Finish)}
          >
            {FINISHES.map((f) => (
              <option key={f}>{f}</option>
            ))}
          </select>
        </label>
      </div>
      <p className="tiny-note">
        Confirm the printed set/number yourself. Condition and finish don’t
        change reference prices.
      </p>
      <button
        className="button primary full-width"
        disabled={
          !Number.isInteger(quantity) || quantity < 1 || quantity > 9999
        }
        onClick={() => onConfirm(quantity, condition, finish)}
      >
        <Check size={17} /> Confirm & add to collection
      </button>
    </article>
  );
}

function CollectionView({
  data,
  setData,
  totals,
  totalCards,
  onScan,
  onExport,
  onImport,
  notify,
}: {
  data: AppData;
  setData: SetAppData;
  totals: ReturnType<typeof referenceTotals>;
  totalCards: number;
  onScan: () => void;
  onExport: () => void;
  onImport: () => void;
  notify: (s: string) => void;
}) {
  const [filter, setFilter] = useState("");
  const [game, setGame] = useState("all");
  const [sort, setSort] = useState("newest");
  const [layout, setLayout] = useState<"grid" | "list">("grid");
  const [deleteEntry, setDeleteEntry] = useState<CollectionEntry | null>(null);
  const entries = data.collection
    .filter(
      (e) =>
        (game === "all" || e.card.game === game) &&
        `${e.card.name} ${e.card.setName} ${e.card.number}`
          .toLowerCase()
          .includes(filter.toLowerCase()),
    )
    .sort((a, b) =>
      sort === "name"
        ? a.card.name.localeCompare(b.card.name)
        : sort === "quantity"
          ? b.quantity - a.quantity
          : b.addedAt.localeCompare(a.addedAt),
    );
  function quantity(entry: CollectionEntry, delta: number) {
    setData((d) => ({
      ...d,
      collection: d.collection.map((e) =>
        e.id === entry.id
          ? { ...e, quantity: Math.max(1, Math.min(9999, e.quantity + delta)) }
          : e,
      ),
    }));
  }
  return (
    <>
      <PageHeading
        eyebrow="THE GOOD STUFF"
        title="Your collection."
        description="Every find, in one place. Saved in this browser and ready to go wherever you do."
        action={
          <div className="button-group">
            <button className="button secondary" onClick={onImport}>
              <ArrowUpFromLine size={16} />
              Import
            </button>
            <button className="button secondary" onClick={onExport}>
              <ArrowDownToLine size={16} />
              Backup
            </button>
            <button className="button primary" onClick={onScan}>
              <Plus size={16} />
              Add cards
            </button>
          </div>
        }
      />
      <div className="collection-stats">
        <div>
          <span>Total cards</span>
          <strong>{totalCards.toLocaleString()}</strong>
          <small>{data.collection.length} collection entries</small>
        </div>
        <div>
          <span>Reference value</span>
          <strong>
            {totals.priced === 0
              ? "—"
              : totals.USD
                ? money(totals.USD)
                : money(totals.EUR, "EUR")}
            {totals.USD > 0 && totals.EUR > 0 && (
              <small> + {money(totals.EUR, "EUR")}</small>
            )}
          </strong>
          <small>
            {totals.priced} priced · {totals.unpriced} without price
          </small>
        </div>
        <div>
          <span>Your data</span>
          <strong className="stat-label">
            <ShieldCheck size={22} />
            Local & private
          </strong>
          <small>Export a backup to keep it safe</small>
        </div>
      </div>
      <p className="valuation-note">
        Reference values are provider snapshots, not an appraisal. Condition,
        finish and fees aren’t reflected.
      </p>
      {data.collection.length === 0 ? (
        <EmptyState
          icon={Layers3}
          title="Start with a single card."
          description="That favorite in your binder. The pull you just opened. Your collection starts here."
          action="Scan or find a card"
          onAction={onScan}
        />
      ) : (
        <>
          <div className="collection-toolbar">
            <div className="search-input">
              <Search size={17} />
              <input
                aria-label="Search collection"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Search your collection…"
              />
            </div>
            <select
              aria-label="Filter collection by game"
              value={game}
              onChange={(e) => setGame(e.target.value)}
            >
              <option value="all">All games</option>
              {Object.entries(GAME_SHORT).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <select
              aria-label="Sort collection"
              value={sort}
              onChange={(e) => setSort(e.target.value)}
            >
              <option value="newest">Newest first</option>
              <option value="name">Name A–Z</option>
              <option value="quantity">Most copies</option>
            </select>
            <div className="view-toggle">
              <button
                aria-label="Grid view"
                aria-pressed={layout === "grid"}
                onClick={() => setLayout("grid")}
              >
                <Grid2X2 size={17} />
              </button>
              <button
                aria-label="List view"
                aria-pressed={layout === "list"}
                onClick={() => setLayout("list")}
              >
                <List size={17} />
              </button>
            </div>
            <button
              className="button subtle"
              onClick={() => {
                downloadFile(
                  collectionCsv(entries),
                  "tcg-scan-collection.csv",
                  "text/csv;charset=utf-8",
                );
                notify(`Exported ${entries.length} visible entries as CSV.`);
              }}
            >
              <Download size={15} />
              CSV
            </button>
          </div>
          <div
            className={`collection-grid ${layout === "list" ? "collection-list" : ""}`}
          >
            {entries.map((entry) => (
              <article className="collection-card panel" key={entry.id}>
                <div className="collection-art">
                  <CardImage card={entry.card} />
                  <span className="tag">{GAME_SHORT[entry.card.game]}</span>
                </div>
                <div className="collection-card-info">
                  <h3>{entry.card.name}</h3>
                  <p>
                    {entry.verification === "identity-only"
                      ? "Visual reference: "
                      : ""}
                    {entry.card.setName} · {entry.card.number || "—"}
                  </p>
                  {entry.printingRead && (
                    <p className="muted">
                      Printed identifiers read: {entry.printingRead.setName} ·{" "}
                      {entry.printingRead.number}. Still unconfirmed:{" "}
                      {entry.printingRead.unconfirmed.join(", ")}.
                    </p>
                  )}
                  <div className="collection-meta">
                    <span>{entry.condition}</span>
                    <span>{entry.finish}</span>
                    {entry.verification && <span>Printing unconfirmed</span>}
                  </div>
                  {entry.verification === "identity-only" && (
                    <ReferenceQuotes
                      card={
                        entry.printingRead
                          ? {
                              ...entry.card,
                              id: entry.printingRead.referenceId,
                              setName: entry.printingRead.setName,
                              setCode: entry.printingRead.setCode,
                              number: entry.printingRead.number,
                              sourceUrl: entry.printingRead.sourceUrl,
                              rarity: "Unknown",
                              prices: [],
                            }
                          : entry.card
                      }
                    />
                  )}
                  <div className="card-bottom">
                    {entry.verification ? (
                      <span className="muted">
                        Identity only · value unavailable
                      </span>
                    ) : (
                      <Price card={entry.card} />
                    )}
                    <div className="quantity-control">
                      <button
                        aria-label={`Decrease ${entry.card.name} quantity`}
                        disabled={entry.quantity <= 1}
                        onClick={() => quantity(entry, -1)}
                      >
                        <Minus size={13} />
                      </button>
                      <span>{entry.quantity}</span>
                      <button
                        aria-label={`Increase ${entry.card.name} quantity`}
                        disabled={entry.quantity >= 9999}
                        onClick={() => quantity(entry, 1)}
                      >
                        <Plus size={13} />
                      </button>
                    </div>
                  </div>
                  <Source card={entry.card} />
                  <button
                    className="remove-card"
                    onClick={() => setDeleteEntry(entry)}
                  >
                    <Trash2 size={12} />
                    Remove
                  </button>
                </div>
              </article>
            ))}
          </div>
          {entries.length === 0 && (
            <div className="empty-inline">
              <Search size={30} />
              <p>No cards match these filters.</p>
              <button
                className="button secondary"
                onClick={() => {
                  setFilter("");
                  setGame("all");
                }}
              >
                Clear filters
              </button>
            </div>
          )}
        </>
      )}
      {deleteEntry && (
        <Modal title="Remove this entry?" onClose={() => setDeleteEntry(null)}>
          <p>
            Remove {deleteEntry.quantity} × {deleteEntry.card.name} (
            {deleteEntry.finish}, {deleteEntry.condition}) from this browser’s
            collection?
          </p>
          <p>
            You can restore it from a previous JSON backup or add the card
            again.
          </p>
          <div className="modal-actions">
            <button
              className="button secondary"
              onClick={() => setDeleteEntry(null)}
            >
              Keep card
            </button>
            <button
              className="button danger"
              onClick={() => {
                setData((d) => ({
                  ...d,
                  collection: d.collection.filter(
                    (e) => e.id !== deleteEntry.id,
                  ),
                }));
                setDeleteEntry(null);
                notify("Collection entry removed.");
              }}
            >
              Remove entry
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
function DeckView({
  data,
  setData,
  notify,
}: {
  data: AppData;
  setData: SetAppData;
  notify: (s: string) => void;
}) {
  const [name, setName] = useState("");
  const [game, setGame] = useState<Game>("mtg");
  const [text, setText] = useState("");
  const [id, setId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Deck | null>(null);
  const result = checkDeck(text, game, data.collection);
  const needed = result.lines.reduce((n, l) => n + l.quantity, 0);
  const missing = result.lines.reduce((n, l) => n + l.missing, 0);
  function save() {
    if (!id && data.decks.length >= 500) {
      notify(
        "You can save up to 500 decks. Export a backup and remove an old deck first.",
      );
      return;
    }
    if (!name.trim() || !result.lines.length) {
      notify("Give your deck a name and add at least one card.");
      return;
    }
    const deck: Deck = {
      id: id ?? crypto.randomUUID(),
      name: name.trim(),
      game,
      text,
      updatedAt: new Date().toISOString(),
    };
    if (
      !setData((d) => ({
        ...d,
        decks: [deck, ...d.decks.filter((v) => v.id !== deck.id)],
      }))
    )
      return;
    setId(deck.id);
    notify("Deck saved in this browser.");
  }
  function open(deck: Deck) {
    setId(deck.id);
    setName(deck.name);
    setGame(deck.game);
    setText(deck.text);
  }
  return (
    <>
      <PageHeading
        eyebrow="FROM BINDER TO BATTLE"
        title="Build with what you have."
        description="Paste a decklist to check your collection and see which cards you’re missing."
      />
      <div className="deck-layout">
        <section className="panel deck-editor">
          <div className="panel-heading">
            <h2>Your decklist</h2>
            <BookOpen size={20} />
          </div>
          <label>
            Deck name
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="A new favorite"
              maxLength={200}
            />
          </label>
          <label>
            Card game
            <select
              value={game}
              onChange={(e) => setGame(e.target.value as Game)}
            >
              {Object.entries(GAME_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Cards
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={"4 Lightning Bolt\n2 Sol Ring\n1 Counterspell"}
              rows={11}
              maxLength={100000}
            />
          </label>
          <p className="tiny-note">
            One card per line, with an optional quantity. Names are matched
            across all printings of the selected game. This checks ownership,
            not format legality.
          </p>
          <div className="button-group">
            <button
              className="button primary"
              onClick={save}
              disabled={!name.trim() || !result.lines.length}
            >
              <Check size={16} />
              Save deck
            </button>
            <button
              className="button secondary"
              onClick={() => {
                setId(null);
                setName("");
                setText("");
              }}
            >
              New deck
            </button>
          </div>
          {data.decks.length > 0 && (
            <div className="saved-decks">
              <p className="eyebrow">SAVED DECKS</p>
              {data.decks.map((deck) => (
                <div
                  key={deck.id}
                  className={
                    deck.id === id ? "saved-deck selected" : "saved-deck"
                  }
                >
                  <button onClick={() => open(deck)}>
                    <FolderOpen size={16} />
                    <span>
                      {deck.name}
                      <small>{GAME_SHORT[deck.game]}</small>
                    </span>
                  </button>
                  <button
                    className="icon-button"
                    aria-label={`Delete ${deck.name}`}
                    onClick={() => setPendingDelete(deck)}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
        <section className="panel deck-results">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">COLLECTION CHECK</span>
              <h2>
                {result.lines.length
                  ? `${needed - missing} of ${needed} cards owned`
                  : "What’s already in your binder?"}
              </h2>
            </div>
            <ClipboardCheck size={22} />
          </div>
          {result.lines.length > 0 ? (
            <>
              <div
                className="progress-bar"
                role="progressbar"
                aria-label="Deck ownership"
                aria-valuemin={0}
                aria-valuemax={needed}
                aria-valuenow={needed - missing}
              >
                <span
                  style={{ width: `${((needed - missing) / needed) * 100}%` }}
                />
              </div>
              <div className="deck-summary">
                <span>
                  <Check size={14} />
                  {needed - missing} ready
                </span>
                <span>{missing} missing</span>
              </div>
              <div className="deck-lines">
                {result.lines.map((line) => (
                  <div className="deck-line" key={line.name}>
                    <span
                      className={
                        line.missing ? "deck-status missing" : "deck-status"
                      }
                    >
                      {line.missing ? <Minus size={14} /> : <Check size={14} />}
                    </span>
                    <span>
                      <strong>{line.name}</strong>
                      <small>
                        {line.owned} owned · {line.quantity} needed
                      </small>
                    </span>
                    <b className={line.missing ? "missing-text" : ""}>
                      {line.missing ? `Need ${line.missing}` : "Ready"}
                    </b>
                  </div>
                ))}
              </div>
              <button
                className="button secondary"
                disabled={!missing}
                onClick={() => {
                  downloadFile(
                    result.lines
                      .filter((l) => l.missing)
                      .map((l) => `${l.missing} ${l.name}`)
                      .join("\n"),
                    `${name.trim() || "deck"}-missing.txt`,
                    "text/plain",
                  );
                  notify("Missing-card list downloaded.");
                }}
              >
                <Copy size={15} />
                Export missing cards
              </button>
            </>
          ) : (
            <div className="deck-empty">
              <BookOpen size={48} />
              <h3>A little less guesswork.</h3>
              <p>
                Add your decklist on the left. We’ll compare it with every card
                you’ve saved.
              </p>
            </div>
          )}
          {result.warnings.map((w) => (
            <p className="inline-warning" key={w}>
              {w}
            </p>
          ))}
        </section>
      </div>
      {pendingDelete && (
        <Modal
          title="Delete this saved deck?"
          onClose={() => setPendingDelete(null)}
        >
          <p>
            Remove “{pendingDelete.name}” from saved decks? Your collection will
            stay as it is.
          </p>
          <div className="modal-actions">
            <button
              className="button secondary"
              onClick={() => setPendingDelete(null)}
            >
              Cancel
            </button>
            <button
              className="button danger"
              onClick={() => {
                setData((d) => ({
                  ...d,
                  decks: d.decks.filter((v) => v.id !== pendingDelete.id),
                }));
                if (id === pendingDelete.id) setId(null);
                setPendingDelete(null);
              }}
            >
              Delete deck
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
