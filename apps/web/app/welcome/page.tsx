import type { Metadata } from "next";
import { SheetGallery } from "./gallery";

export const metadata: Metadata = {
  title: "Elettro OS | Create once. Publish everywhere.",
  description:
    "Elettro OS is the publishing system from Elettro Incorporated: one brand library, a weekly plan per network, human approval, and scheduled publishing to YouTube, Instagram, Facebook, Threads and more. Access is by invitation."
};

const CONTACT = "mailto:contact@elettro.com?subject=Elettro%20OS%20access";

type Status = "live" | "review" | "rolling" | "soon";
const STATUS_LABEL: Record<Status, string> = { live: "Live", review: "In app review", rolling: "Rolling out", soon: "Coming" };

const PLATFORMS: Array<{ name: string; formats: string; status: Status }> = [
  { name: "YouTube", formats: "Shorts and long-form videos", status: "live" },
  { name: "Instagram", formats: "Reels", status: "live" },
  { name: "Facebook", formats: "Reels", status: "live" },
  { name: "Threads", formats: "Posts", status: "live" },
  { name: "TikTok", formats: "Videos", status: "review" },
  { name: "Pinterest", formats: "Image and video pins", status: "rolling" },
  { name: "LinkedIn", formats: "Posts", status: "rolling" },
  { name: "Google Business Profile", formats: "Update posts", status: "soon" },
  { name: "X", formats: "Videos", status: "soon" }
];

const FEATURES: Array<[string, string]> = [
  ["One brand library", "Photos, video and brand notes live in the brand's Dropbox folder. Elettro OS indexes them, reads their tags, and keeps the approved ones ready to post."],
  ["A weekly plan for every network", "The planner fits each network's formats and daily limits, spreads the brand's content mix across the week, and avoids repeating the same clip too soon."],
  ["Copy written for each network", "Titles, captions and hashtags follow each network's length and style limits, and use only facts from the brand's own records: songs, products, venues and links."],
  ["Review and approve", "Every post is shown before it goes out. Edit the caption, swap the clip, skip it, or approve the whole week."],
  ["Scheduled publishing", "Approved posts publish at their planned time to the brand's own accounts, with a record of what went out and when."],
  ["Many brands, one place", "Each brand has its own accounts, cadence and approvals. Owners connect their channels through the network's own sign-in and can disconnect at any time."]
];

const STEPS: Array<[string, string]> = [
  ["Build the library", "Add photos, video and notes for the brand."],
  ["Plan the week", "Elettro OS drafts a plan that fits each network."],
  ["Review and approve", "A person checks and approves every post."],
  ["Publish on schedule", "Posts go to the connected accounts at the planned time."],
  ["Stay in control", "Reconnect reminders, a clear status for every post, and one-click disconnect."]
];

const FAQ: Array<[string, string]> = [
  ["Who can use Elettro OS?", "It is not open to the public. Elettro staff and people Elettro authorizes, such as a client brand's team, can sign in. To ask for access, contact Elettro."],
  ["Does it post without my approval?", "Brands run in approval mode: the week's posts are reviewed and approved by a person before they publish."],
  ["What does it access on my YouTube channel?", "Two permissions only: upload videos you approved, and view your YouTube account so we can confirm which channel you connected. We store the channel ID, title and handle, and the IDs of videos we uploaded."],
  ["Can I disconnect?", "Yes, any time, from Google's security settings or the network's own app settings. We delete the stored token and channel data within 7 days of your request, or within 30 days of a revocation in Google's security settings."],
  ["Do you sell or reuse my data?", "No. We do not sell it, use it for advertising, or use it to train AI models. Read the full Privacy Policy linked below."],
  ["Which networks are live?", "YouTube, Instagram Reels, Facebook Reels and Threads publish on schedule today. TikTok is in the network's app review, and Pinterest and LinkedIn are rolling out."]
];

export default function Welcome() {
  return (
    <div className="pub">
      <header className="pub-top">
        <a className="pub-brand" href="#top">Elettro <span>OS</span></a>
        <nav className="pub-nav" aria-label="Elettro OS">
          <a href="#platforms">Platforms</a>
          <a href="#features">Features</a>
          <a href="#how">How it works</a>
          <a href="#sheets">One-sheets</a>
          <a href="#data">Your data</a>
          <a href="#faq">FAQ</a>
          <a className="pub-login" href="/api/auth/login"><span>Login</span></a>
        </nav>
      </header>

      <main id="top">
        <section className="pub-hero">
          <p className="pub-eyebrow">Marketing | Social media | AI | Tech</p>
          <h1>Create once.<br /><em>Publish everywhere.</em></h1>
          <p className="pub-lede">
            Elettro OS is the publishing system from Elettro Incorporated. One brand library, a weekly plan that fits each network,
            a person approving every post, and scheduled publishing to the brand&apos;s own accounts.
          </p>
          <div className="pub-cta-row">
            <a className="pub-cta" href={CONTACT}><span>Contact Elettro for access</span><i aria-hidden="true">&rarr;</i></a>
            <a className="pub-ghost" href="/api/auth/login">Team login</a>
          </div>
          <p className="pub-note">Elettro OS is not open to the public. Access is by invitation.</p>
        </section>

        <section id="platforms" className="pub-section">
          <h2>Where it publishes</h2>
          <p className="pub-sub">Each network has its own formats, limits and rules. Elettro OS plans for them and publishes through the network&apos;s official API.</p>
          <ul className="pub-platforms">
            {PLATFORMS.map((p) => (
              <li key={p.name}>
                <strong>{p.name}</strong>
                <span>{p.formats}</span>
                <em className={`pub-badge ${p.status}`}>{STATUS_LABEL[p.status]}</em>
              </li>
            ))}
          </ul>
        </section>

        <section id="features" className="pub-section">
          <h2>What you get</h2>
          <div className="pub-cards">
            {FEATURES.map(([title, body]) => (
              <article key={title}><h3>{title}</h3><p>{body}</p></article>
            ))}
          </div>
        </section>

        <section id="how" className="pub-section">
          <h2>How it works</h2>
          <ol className="pub-flow">
            {STEPS.map(([title, body], i) => (
              <li key={title}><b>{i + 1}</b><h3>{title}</h3><p>{body}</p></li>
            ))}
          </ol>
        </section>

        <section id="sheets" className="pub-section">
          <h2>Built for restaurants, venues, hotels and brands</h2>
          <p className="pub-sub">One-sheets from Elettro. Open any sheet to read it full size.</p>
          <SheetGallery />
          <p className="pub-fine">
            Sheets are sample layouts. Scenes are illustrative and any figures shown are examples, not guaranteed results.
            Sheets marked Coming soon show features that are still in development.
          </p>
        </section>

        <section id="data" className="pub-section pub-data">
          <h2>Your data and your control</h2>
          <ul>
            <li><b>You approve the connection.</b> Sign-in happens on the network&apos;s own page. Elettro OS never sees your password, and receives only what that screen asks you to approve.</li>
            <li><b>A person approves the posts.</b> Nothing publishes until the week is approved.</li>
            <li><b>Tokens are encrypted.</b> Access tokens are stored encrypted in AWS Secrets Manager, in the United States.</li>
            <li><b>Not sold, not reused.</b> No selling, no advertising use, no AI training on connected-account data.</li>
            <li><b>Leave any time.</b> Disconnect on the network and we delete the stored token and channel data. Deletion requests: contact@elettro.com.</li>
          </ul>
          <p>
            Elettro OS uses YouTube API Services. By connecting a YouTube channel you agree to the{" "}
            <a href="https://www.youtube.com/t/terms" rel="noopener">YouTube Terms of Service</a>, and Google&apos;s handling of your data is described in the{" "}
            <a href="https://policies.google.com/privacy" rel="noopener">Google Privacy Policy</a>. Our use of information received from Google APIs adheres to the{" "}
            <a href="https://developers.google.com/terms/api-services-user-data-policy" rel="noopener">Google API Services User Data Policy</a>, including the Limited Use requirements.
            You can revoke access in your <a href="https://myaccount.google.com/permissions" rel="noopener">Google security settings</a>.
          </p>
          <p><a href="https://elettro.com/privacy/">Read the Privacy Policy</a> &middot; <a href="https://elettro.com/terms/">Read the Terms of Service</a></p>
        </section>

        <section id="faq" className="pub-section">
          <h2>Questions</h2>
          <div className="pub-faq">
            {FAQ.map(([q, a]) => (
              <details key={q}><summary>{q}</summary><p>{a}</p></details>
            ))}
          </div>
        </section>

        <section id="access" className="pub-access">
          <h2>Want Elettro OS for your brand?</h2>
          <p>Tell us about your business and we will set up your access.</p>
          <a className="pub-cta" href={CONTACT}><span>Contact Elettro for access</span><i aria-hidden="true">&rarr;</i></a>
          <p className="pub-fine">Or call 310.408.6687 &middot; <a href="https://elettro.com/contact/">elettro.com/contact</a> &middot; Already have access? <a href="/api/auth/login">Log in</a></p>
        </section>
      </main>

      <footer className="pub-foot">
        <div>
          <strong>Elettro Incorporated</strong>
          <span>2231 SW 97th Road, Davie, Florida 33324 &middot; contact@elettro.com &middot; 310.408.6687</span>
        </div>
        <nav aria-label="Legal">
          <a href="https://elettro.com/privacy/">Privacy Policy</a>
          <a href="https://elettro.com/terms/">Terms of Service</a>
          <a href="https://elettro.com/">elettro.com</a>
        </nav>
        <p>Elettro OS is operated by Elettro Incorporated, at os.elettro.com, part of elettro.com. It uses YouTube API Services; see the YouTube Terms of Service and Google Privacy Policy above.</p>
      </footer>
    </div>
  );
}
