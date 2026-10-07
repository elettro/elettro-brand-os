import { IntakeClient } from "./intake-client";

export default function AddAssetsPage() {
  return (
    <main className="main">
      <div className="eyebrow">Asset Intake</div>
      <h1>Add Assets</h1>
      <p className="muted">
        Drag in a batch, give the group only the context you know now, and let Brand OS analyze the rest.
      </p>
      <div style={{ marginTop: 20 }}>
        <IntakeClient />
      </div>
    </main>
  );
}
