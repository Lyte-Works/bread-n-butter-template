import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

/**
 * The restaurant's name: `.lyte/field.json` at the repo root (`name`, then
 * `slug`), falling back to the repo folder's name. Read on each request, so a
 * filled-in field.json shows without a rebuild.
 */
function restaurantName() {
  const root = resolve(process.cwd(), "..");
  try {
    const field = JSON.parse(readFileSync(resolve(root, ".lyte", "field.json"), "utf8"));
    const name = typeof field.name === "string" && field.name.trim() ? field.name.trim() : null;
    const slug = typeof field.slug === "string" && field.slug.trim() ? field.slug.trim() : null;
    if (name || slug) return name || slug;
  } catch {
    // no field.json yet: fall through to the folder name
  }
  return basename(root);
}

export const dynamic = "force-dynamic";

export default function Home() {
  return (
    <main style={{ maxWidth: "40rem", margin: "0 auto", padding: "4rem 1.5rem" }}>
      <h1 style={{ fontSize: "2rem", margin: "0 0 1rem" }}>{restaurantName()}</h1>
      <p style={{ fontSize: "1.125rem", lineHeight: 1.5, margin: 0 }}>
        This is your site. Your AI and you build it here; what you publish goes live.
      </p>
    </main>
  );
}
