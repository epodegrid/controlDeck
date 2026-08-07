/**
 * The synthetic cast that generates traffic.
 *
 * These are the platform's "users" in the only sense the PRD allows: there is
 * no user table (§3 — no platform-side RBAC), so a caller is nothing more than
 * the identity claims on an Entra token. Each persona is therefore just a set
 * of JWT claims plus a behaviour profile describing what they tend to ask for.
 *
 * Teams line up with the audit logging scopes in the seed, so content-logging
 * toggles have observable consequences. Note the rule is OR-across-scopes
 * (§6.8): `design` and `external` have their *team* scope off, but their
 * traffic is still logged whenever it lands on a model whose own scope is on.
 * The rows that end up metadata-only are the ones where team and model are
 * both off — e.g. `search` on `ember-embed`. That interaction is the point:
 * it is exactly what an admin needs the Audit page to make obvious.
 */

export type Behaviour =
  /** Short, cheap questions — should auto-route to the fast model. */
  | "quick"
  /** Long analytical prompts — should auto-route to the large model. */
  | "analytical"
  /** Attaches images — should auto-route to the vision model. */
  | "vision"
  /** Hits /v1/embeddings — should route to the embedding model. */
  | "embedding"
  /** Supplies a tools[] array — needs a model with the tools capability. */
  | "tooluser"
  /** Names a model explicitly, exercising the override path (§6.3 rule 1). */
  | "explicit";

export type Persona = {
  oid: string;
  name: string;
  team: string;
  /** Relative share of total traffic. Higher = chattier. */
  weight: number;
  /** Behaviours this persona draws from, sampled uniformly. */
  behaviours: Behaviour[];
  /** Chance a given request is sent with stream: true. */
  streamRate: number;
};

export const PERSONAS: Persona[] = [
  { oid: "4f1c8a02-1111-4a11-9c01-aa0000000001", name: "Priya Raman", team: "engineering", weight: 10, behaviours: ["quick", "analytical", "tooluser"], streamRate: 0.7 },
  { oid: "4f1c8a02-1111-4a11-9c01-aa0000000002", name: "Tom Okafor", team: "engineering", weight: 8, behaviours: ["quick", "explicit"], streamRate: 0.6 },
  { oid: "4f1c8a02-1111-4a11-9c01-aa0000000003", name: "Wei Zhang", team: "search", weight: 12, behaviours: ["embedding", "quick"], streamRate: 0.2 },
  { oid: "4f1c8a02-1111-4a11-9c01-aa0000000004", name: "Sofia Marchetti", team: "search", weight: 6, behaviours: ["embedding"], streamRate: 0.0 },
  { oid: "4f1c8a02-1111-4a11-9c01-aa0000000005", name: "Dan Whitfield", team: "platform", weight: 7, behaviours: ["analytical", "tooluser"], streamRate: 0.8 },
  { oid: "4f1c8a02-1111-4a11-9c01-aa0000000006", name: "Aisha Nkemelu", team: "platform", weight: 5, behaviours: ["quick", "analytical"], streamRate: 0.5 },
  { oid: "4f1c8a02-1111-4a11-9c01-aa0000000007", name: "Marcus Lindqvist", team: "ml-ops", weight: 9, behaviours: ["analytical", "explicit"], streamRate: 0.9 },
  { oid: "4f1c8a02-1111-4a11-9c01-aa0000000008", name: "Nina Vasquez", team: "ml-ops", weight: 4, behaviours: ["embedding", "analytical"], streamRate: 0.3 },
  // design + external have content logging disabled in the seed — their rows
  // should appear in Audit with metadata only and no prompt/response body.
  { oid: "4f1c8a02-1111-4a11-9c01-aa0000000009", name: "Jonas Peterson", team: "design", weight: 6, behaviours: ["vision", "quick"], streamRate: 0.4 },
  { oid: "4f1c8a02-1111-4a11-9c01-aa0000000010", name: "Leila Haddad", team: "design", weight: 5, behaviours: ["vision"], streamRate: 0.4 },
  { oid: "4f1c8a02-1111-4a11-9c01-aa0000000011", name: "Ben Achterberg", team: "support", weight: 7, behaviours: ["quick"], streamRate: 0.6 },
  { oid: "4f1c8a02-1111-4a11-9c01-aa0000000012", name: "svc-openwebui", team: "external", weight: 14, behaviours: ["quick", "analytical", "vision"], streamRate: 1.0 },
];

const TOTAL_WEIGHT = PERSONAS.reduce((acc, p) => acc + p.weight, 0);

/** Samples a persona proportionally to its weight. */
export function pickPersona(rand: () => number = Math.random): Persona {
  let roll = rand() * TOTAL_WEIGHT;
  for (const p of PERSONAS) {
    roll -= p.weight;
    if (roll <= 0) return p;
  }
  return PERSONAS[PERSONAS.length - 1];
}

export function pickBehaviour(persona: Persona, rand: () => number = Math.random): Behaviour {
  return persona.behaviours[Math.floor(rand() * persona.behaviours.length)];
}
