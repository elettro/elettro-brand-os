"use client";

import { useState } from "react";
import type { ReviewPost, TiktokCreator, TiktokSettings } from "@/lib/planner-review";

const PRIVACY: Record<string, string> = {
  PUBLIC_TO_EVERYONE: "Everyone",
  MUTUAL_FOLLOW_FRIENDS: "Friends",
  FOLLOWER_OF_CREATOR: "Followers",
  SELF_ONLY: "Only me"
};

// TikTok's Content Posting rules, shown before every TikTok approval: the account it posts to,
// who can view (no default), comments/duet/stitch, the commercial content disclosure and the
// consent line. Approving sends these settings with the post.
export function TiktokCard({ post, creator, creatorError, busy, onApprove }: {
  post: ReviewPost; creator: TiktokCreator | null; creatorError: string | null; busy: boolean;
  onApprove: (settings: TiktokSettings & { disclose: boolean }) => void;
}) {
  const saved = post.tiktok;
  const [privacyLevel, setPrivacy] = useState(saved?.privacyLevel || "");
  const [allowComment, setComment] = useState(saved?.allowComment ?? false);
  const [allowDuet, setDuet] = useState(saved?.allowDuet ?? false);
  const [allowStitch, setStitch] = useState(saved?.allowStitch ?? false);
  const [disclose, setDisclose] = useState(Boolean(saved?.yourBrand || saved?.brandedContent));
  const [yourBrand, setYourBrand] = useState(saved?.yourBrand ?? false);
  const [brandedContent, setBranded] = useState(saved?.brandedContent ?? false);

  if (creatorError) return <p className="review-warn">TikTok account unavailable: {creatorError}</p>;
  if (!creator) return <p className="muted tiktok-card">Checking the TikTok account…</p>;

  const tooLong = creator.maxVideoPostDurationSec && post.asset.durationMs
    ? post.asset.durationMs / 1000 > creator.maxVideoPostDurationSec : false;
  const disclosureIncomplete = disclose && !yourBrand && !brandedContent;
  const ready = Boolean(privacyLevel) && !disclosureIncomplete && !tooLong;

  return <div className="tiktok-card">
    <div className="tiktok-account">
      {creator.avatarUrl && <img src={creator.avatarUrl} alt="" width={28} height={28} />}
      <span>Posting to <b>{creator.nickname || creator.username}</b>{creator.username && <span className="muted"> @{creator.username}</span>}</span>
    </div>
    {tooLong && <p className="review-warn">This clip is longer than the {creator.maxVideoPostDurationSec}s TikTok allows for this account. Swap the clip.</p>}
    <label className="tiktok-field">Who can view this video
      <select value={privacyLevel} onChange={(e) => setPrivacy(e.target.value)}>
        <option value="" disabled>Choose…</option>
        {creator.privacyLevelOptions.map((o) => <option key={o} value={o}
          disabled={brandedContent && o === "SELF_ONLY"}
          title={brandedContent && o === "SELF_ONLY" ? "Branded content visibility can't be set to private" : undefined}>{PRIVACY[o] || o}</option>)}
      </select>
    </label>
    <div className="tiktok-toggles">
      <label><input type="checkbox" checked={allowComment && !creator.commentDisabled} disabled={creator.commentDisabled} onChange={(e) => setComment(e.target.checked)} /> Allow comments</label>
      <label><input type="checkbox" checked={allowDuet && !creator.duetDisabled} disabled={creator.duetDisabled} onChange={(e) => setDuet(e.target.checked)} /> Allow Duet</label>
      <label><input type="checkbox" checked={allowStitch && !creator.stitchDisabled} disabled={creator.stitchDisabled} onChange={(e) => setStitch(e.target.checked)} /> Allow Stitch</label>
    </div>
    <label className="tiktok-switch"><input type="checkbox" checked={disclose} onChange={(e) => { setDisclose(e.target.checked); if (!e.target.checked) { setYourBrand(false); setBranded(false); } }} />
      Disclose video content <span className="muted">— this video promotes goods or services in exchange for something of value</span></label>
    {disclose && <div className="tiktok-disclosure">
      <label><input type="checkbox" checked={yourBrand} onChange={(e) => setYourBrand(e.target.checked)} /> Your brand <span className="muted">— promoting yourself or your own business</span></label>
      <label><input type="checkbox" checked={brandedContent} onChange={(e) => { setBranded(e.target.checked); if (e.target.checked && privacyLevel === "SELF_ONLY") setPrivacy(""); }} /> Branded content <span className="muted">— promoting another brand or a third party</span></label>
      {disclosureIncomplete && <p className="review-warn">You need to indicate if your content promotes yourself, a third party, or both.</p>}
      {(yourBrand || brandedContent) && <p className="muted tiktok-label">Your video will be labeled “{brandedContent ? "Paid partnership" : "Promotional content"}”.</p>}
    </div>}
    <p className="muted tiktok-consent">
      By posting, you agree to TikTok&apos;s{" "}
      {brandedContent && <><a href="https://www.tiktok.com/legal/page/global/bc-policy/en" target="_blank" rel="noreferrer">Branded Content Policy</a> and{" "}</>}
      <a href="https://www.tiktok.com/legal/page/global/music-usage-confirmation/en" target="_blank" rel="noreferrer">Music Usage Confirmation</a>.
      {" "}After it posts, TikTok may take a few minutes to process the video before it appears on the profile.
    </p>
    <div className="review-actions">
      <button className="status-chip" disabled={busy || !ready} onClick={() => onApprove({
        privacyLevel, allowComment: allowComment && !creator.commentDisabled, allowDuet: allowDuet && !creator.duetDisabled,
        allowStitch: allowStitch && !creator.stitchDisabled, yourBrand, brandedContent, disclose
      })}>{post.status === "approved" ? "Update TikTok settings" : "Approve for TikTok"}</button>
    </div>
  </div>;
}
