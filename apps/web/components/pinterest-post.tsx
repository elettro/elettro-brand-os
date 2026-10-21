"use client";

import { useEffect, useState } from "react";
import { Picker } from "@/components/meta-test-posts";

type Asset = { id: string; filename: string; kind: string; sourcePath: string | null; title: string | null; aspectRatioLabel: string | null; durationMs: number | null; mimeType: string | null };
type Board = { id: string; name: string; privacy: string };

const DEFAULT_TITLE = "Testing Elettro OS on Pinterest";
const DEFAULT_DESCRIPTION = "This Pin went out through Elettro OS, our in-house publishing system.";

async function call<T>(body: Record<string, unknown>): Promise<T> {
  const response = await fetch("/api/connections/pinterest/post", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({})) as T & { ok?: boolean; error?: string };
  if (!response.ok || !data.ok) throw Error(data.error || `HTTP ${response.status}`);
  return data;
}

// Post one approved library image or video as a Pin to a board on the brand's Pinterest account.
export function PinterestPost({ brand }: { brand: string }) {
  const [boards, setBoards] = useState<Board[]>([]);
  const [boardId, setBoardId] = useState("");
  const [newBoard, setNewBoard] = useState("Elettro");
  const [asset, setAsset] = useState<Asset | null>(null);
  const [title, setTitle] = useState(DEFAULT_TITLE);
  const [description, setDescription] = useState(DEFAULT_DESCRIPTION);
  const [link, setLink] = useState("https://elettro.com");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ url?: string; error?: string; logged?: boolean } | null>(null);
  const [step, setStep] = useState<string | null>(null);

  useEffect(() => {
    call<{ boards: Board[] }>({ brand, step: "boards" })
      .then((d) => { setBoards(d.boards); if (d.boards[0]) setBoardId(d.boards[0].id); })
      .catch((e) => setResult({ error: e instanceof Error ? e.message : "Could not load boards" }));
  }, [brand]);

  async function addBoard() {
    setBusy(true); setResult(null);
    try {
      const { board } = await call<{ board: Board }>({ brand, step: "board", boardName: newBoard });
      setBoards([board, ...boards]); setBoardId(board.id);
    } catch (e) {
      setResult({ error: e instanceof Error ? e.message : "Could not create the board" });
    } finally {
      setBusy(false);
    }
  }

  async function post() {
    if (!asset || !boardId) return;
    setBusy(true); setResult(null);
    try {
      let mediaId: string | undefined;
      if (asset.kind === "video") {
        setStep("Uploading the video to Pinterest…");
        mediaId = (await call<{ mediaId: string }>({ brand, step: "video", assetId: asset.id })).mediaId;
        // Pinterest processes the upload before it can be pinned; it reports "succeeded" when ready.
        for (let i = 0; ; i += 1) {
          const { status } = await call<{ status: string }>({ brand, step: "media", mediaId });
          if (status === "succeeded") break;
          if (status === "failed") throw Error("Pinterest could not process the video");
          if (i === 60) throw Error("Pinterest is still processing after 5 minutes; try again later");
          setStep(`Pinterest is processing the video… (${(i + 1) * 5}s)`);
          await new Promise((r) => setTimeout(r, 5000));
        }
      }
      setStep("Pinning…");
      setResult(await call<{ url: string; logged: boolean }>({ brand, step: "pin", boardId, assetId: asset.id, mediaId, title, description, link }));
    } catch (e) {
      setResult({ error: e instanceof Error ? e.message : "Pin failed" });
    } finally {
      setBusy(false); setStep(null);
    }
  }

  return <div className="test-post">
    <div className="eyebrow">Post a Pin</div>
    {boards.length ? <>
      <label className="muted" htmlFor={`pin-board-${brand}`}>Board</label>
      <select id={`pin-board-${brand}`} value={boardId} onChange={(e) => setBoardId(e.target.value)}>
        {boards.map((b) => <option key={b.id} value={b.id}>{b.name}{b.privacy === "SECRET" ? " (secret)" : ""}</option>)}
      </select>
    </> : <p className="muted" style={{ margin: 0 }}>No boards yet; create one first.</p>}
    <div className="connect-row">
      <input value={newBoard} onChange={(e) => setNewBoard(e.target.value)} maxLength={50} aria-label="New board name" />
      <button type="button" className="status-chip" disabled={busy || !newBoard.trim()} onClick={addBoard}>Create board</button>
    </div>
    <Picker brand={brand} network="pinterest" selected={asset} onSelect={setAsset} blockedId={null} />
    {asset && <p className="muted" style={{ margin: 0 }}>Selected: <b>{asset.title || asset.filename}</b> · posts as a {asset.kind === "video" ? "video Pin" : "Pin"}</p>}
    <label className="muted" htmlFor={`pin-title-${brand}`}>Title</label>
    <input id={`pin-title-${brand}`} value={title} maxLength={100} onChange={(e) => setTitle(e.target.value)} />
    <label className="muted" htmlFor={`pin-desc-${brand}`}>Description</label>
    <textarea id={`pin-desc-${brand}`} rows={3} maxLength={800} value={description} onChange={(e) => setDescription(e.target.value)} />
    <label className="muted" htmlFor={`pin-link-${brand}`}>Link</label>
    <input id={`pin-link-${brand}`} value={link} onChange={(e) => setLink(e.target.value)} />
    <button type="button" className="status-chip" disabled={!asset || !boardId || !title.trim() || busy} onClick={post}>
      {busy ? step || "Working…" : "Post to Pinterest now"}
    </button>
    {result?.url && <p className="card">Pinned. <a href={result.url} target="_blank" rel="noreferrer">See the Pin</a>
      {result.logged === false && <span className="muted"> (live, but not logged for the dashboard)</span>}</p>}
    {result?.error && <p className="card">Pin not sent: {result.error}</p>}
  </div>;
}
