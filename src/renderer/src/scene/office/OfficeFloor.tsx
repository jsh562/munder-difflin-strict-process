import { useEffect, useRef } from 'react';
import { Application, Container, Graphics, Text, Ticker, Texture } from 'pixi.js';
// PixiJS uses new Function() internally, blocked by Electron CSP — this patches it.
import 'pixi.js/unsafe-eval';
import { useStore, type Agent } from '@/store/store';
import { TiledMapRenderer, type TiledMap } from './TiledMapRenderer';
import { Camera } from './Camera';
import { Character } from './Character';
import { MessageEnvelope, type MessageAct } from './MessageEnvelope';
import { getCastFrames, CAST_BY_NAME, hexToNumber, DEFAULT_CHARACTER } from './cast';
import { pickSoloLine, pickExchange, type BreakSpot } from './cafeteriaLines';
import { colors } from '@/design/tokens';

import officeTilesetUrl from '@/assets/tilesets/office-tileset.png?url';
import a5FloorsWallsUrl from '@/assets/tilesets/a5-office-floors-walls.png?url';
import interiorsUrl from '@/assets/tilesets/interiors.png?url';
// .tmj is Tiled JSON; import as raw text (typed by vite/client) and parse.
import officeMapRaw from '@/assets/maps/office.tmj?raw';

const officeMapData = JSON.parse(officeMapRaw) as TiledMap;

// Preferred desks, in claim order. The very first agent always takes the
// private office on the left (the CEO room), then the open-plan PC desks, then
// the remaining named desks. Overflow (conference room, then open floor) is
// computed from map zones at runtime. Matches Tiled spawn-point names.
const PRIMARY_SEAT_NAMES = [
  'desk-ceo',
  'pc-1', 'pc-2', 'pc-3', 'pc-4', 'pc-5', 'pc-6',
  'desk-chief-architect', 'desk-product-manager', 'desk-team-lead',
  'desk-backend-engineer', 'desk-ui-ux-expert', 'desk-data-engineer',
  'desk-project-manager', 'desk-market-researcher', 'desk-agent-organizer',
];

interface Tile { x: number; y: number; }
type Facing = 'up' | 'down' | 'left' | 'right';

/** A cafeteria break in progress for one agent — set by the coffee-break
 *  director, cleared when the agent leaves or gets pulled back to work. */
interface CafeChat {
  lines: readonly string[];        // alternating beats: even = initiator, odd = partner
  partnerId: string;
  idx: number;                     // next beat to speak
  beat: number;                    // seconds until the next beat
}

interface CafeBreak {
  spotIdx: number;                 // index into cafeSpots
  phase: 'walking' | 'lingering';
  timer: number;                   // walking → elapsed watchdog; lingering → countdown
  quipTimer: number;               // until the next solo quip swap
  chat?: CafeChat;                 // set on the conversation's initiator
  chattingWith?: string;           // set on the partner: stays put & stays quiet
}

interface Runtime {
  character: Character;
  seatIndex: number | null;
  waitTile: Tile;
  charName: string;
  prevStatus?: string;
  prevAction?: string;
  prevCarrying?: string;
  prevPrompt?: string;
  brk?: CafeBreak;
}

/** Patch the map's external (.tsx) tileset refs with the inline metadata the
 *  renderer needs — mirrors the reference repo's OfficeScene.init(). */
function resolveMap(): TiledMap {
  const m = officeMapData;
  return {
    ...m,
    tilesets: [
      m.tilesets[0], // office-tileset.png (embedded, firstgid 1)
      { firstgid: 513, image: 'a5', imagewidth: 256, imageheight: 512, tilewidth: 16, tileheight: 16, columns: 16, tilecount: 512 } as any,
      { firstgid: 1025, image: 'interiors', imagewidth: 256, imageheight: 1424, tilewidth: 16, tileheight: 16, columns: 16, tilecount: 1424 } as any,
    ],
  };
}

/** Load a texture via an <img> element. Unlike Pixi's Assets.load(), this
 *  handles extension-less data: URLs (Vite inlines small assets like the a5
 *  tileset as base64), which the Assets resolver fails to type-detect. */
function loadTexture(url: string): Promise<Texture> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const tex = Texture.from(img);
      tex.source.scaleMode = 'nearest';
      resolve(tex);
    };
    img.onerror = () => reject(new Error('failed to load ' + url.slice(0, 40)));
    img.src = url;
  });
}

/** What the agent is doing right now, for the thought cloud. Prefer the live
 *  `action` (e.g. "edit App.tsx", "bash npm test"), fall back to the prompt we
 *  gave it, then to a caller-supplied generic. Returns '' for the working state
 *  with nothing concrete yet — the bubble renders an animated "…" for that. */
function liveActivity(agent: Agent, fallback = ''): string {
  const action = (agent.action || '').trim();
  if (action) return action;
  return firstWords(agent.lastPrompt) || fallback;
}

/** First few words of the last user prompt, for the desk card. */
function firstWords(prompt: string | undefined, maxWords = 6, maxChars = 42): string {
  if (!prompt) return '';
  const words = prompt.trim().split(/\s+/);
  let out = words.slice(0, maxWords).join(' ');
  const truncatedWords = words.length > maxWords;
  if (out.length > maxChars) out = out.slice(0, maxChars).trimEnd();
  else if (truncatedWords) out += '…';
  return out;
}

export function OfficeFloor() {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const appRef = useRef<Application | null>(null);
  const mountIdRef = useRef(0);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    while (host.firstChild) host.removeChild(host.firstChild);

    const mountId = ++mountIdRef.current;
    const app = new Application();
    appRef.current = app;

    const runtimes = new Map<string, Runtime>();
    const seatClaims = new Set<number>();
    // In-flight message envelopes (sender desk → recipient desk). Capped so a
    // broadcast doesn't bury the floor in paper.
    const envelopes: MessageEnvelope[] = [];
    const MAX_ENVELOPES = 16;

    const init = async () => {
      await app.init({
        background: hexNum(colors.ink[900]),
        antialias: false,
        roundPixels: true,
        // resolution: 1 let the OS/browser upscale the canvas on scaled and
        // HiDPI displays (125–150% is the Windows laptop default), blurring
        // everything — worst of all the bubble text, which is small to begin
        // with. Render at the real device pixel density instead, floored at 2
        // so the half-scale-supersampled bubble text stays legible even at
        // 100% scaling. autoDensity keeps the canvas CSS size in logical px.
        resolution: Math.max(window.devicePixelRatio || 1, 2),
        autoDensity: true,
        width: host.clientWidth || 800,
        height: host.clientHeight || 600,
      });
      if (mountIdRef.current !== mountId) { safeDestroy(app); return; }
      while (host.firstChild) host.removeChild(host.firstChild);
      host.appendChild(app.canvas);

      // Load tilesets (order must match resolveMap()'s tileset array)
      const [officeTex, a5Tex, interiorsTex] = await Promise.all(
        [officeTilesetUrl, a5FloorsWallsUrl, interiorsUrl].map(loadTexture),
      );
      if (mountIdRef.current !== mountId) { safeDestroy(app); return; }

      const world = new Container();
      app.stage.addChild(world);

      const mapRenderer = new TiledMapRenderer(resolveMap(), [officeTex, a5Tex, interiorsTex]);
      world.addChild(mapRenderer.getContainer());
      const charLayer = mapRenderer.getCharacterContainer();
      const tileCount = mapRenderer.getContainer().children.reduce(
        (n, c) => n + ((c as Container).children?.length ?? 0), 0);
      console.log(`[OfficeFloor] map ${mapRenderer.width}x${mapRenderer.height}, ${tileCount} tile sprites rendered`);

      const camera = new Camera(world);
      camera.setMapSize(mapRenderer.width * mapRenderer.tileSize, mapRenderer.height * mapRenderer.tileSize);
      camera.setViewSize(app.screen.width, app.screen.height);
      camera.fitToScreen();

      // Build the ordered seat list once: PC desks + named desks first, then
      // conference-room chairs as overflow. Each agent claims one and stays there;
      // they never wander off it (except when blocked, or on a coffee break).
      const seatTiles: Tile[] = [];
      const seatSeen = new Set<string>();
      const addSeat = (t?: Tile) => {
        if (!t) return;
        const k = `${t.x},${t.y}`;
        if (seatSeen.has(k)) return;
        seatSeen.add(k);
        seatTiles.push({ x: t.x, y: t.y });
      };
      for (const name of PRIMARY_SEAT_NAMES) addSeat(mapRenderer.getSpawnPoint(name));
      const addZoneSeats = (zone: string) => {
        const z = mapRenderer.getZone(zone);
        if (!z) return;
        for (let y = z.y; y < z.y + z.height; y++) {
          for (let x = z.x; x < z.x + z.width; x++) {
            if (mapRenderer.isWalkable(x, y)) addSeat({ x, y });
          }
        }
      };
      addZoneSeats('boardroom');       // conference room overflow

      // A clickable KANBAN BOARD on the conference-room wall — opens the big task board
      // over the office (TaskBoardOverlay). Drawn (no art asset); tracks the map (in
      // `world`) so it pans/zooms. Mirrors the Character onClick pattern.
      const boardZone = mapRenderer.getZone('boardroom');
      if (boardZone) {
        const ts = mapRenderer.tileSize;
        const cols = [0x8fc7e8, 0xf2d27a, 0x9bd9a8];
        const bw = Math.min(boardZone.width, 4) * ts;
        const bh = 1.6 * ts;
        const bx = (boardZone.x + Math.max(0, (boardZone.width - 4) / 2)) * ts;
        const by = boardZone.y * ts - bh * 0.2;
        const board = new Container();
        board.position.set(bx, by);
        const g = new Graphics();
        g.rect(0, 0, bw, bh).fill(0xfbf7ec).stroke({ width: 3, color: 0x1c1410 });
        g.rect(0, 0, bw, bh * 0.22).fill(0xe8dfc8);
        const pad = bw * 0.04;
        const colW = (bw - pad * (cols.length + 1)) / cols.length;
        const colY = bh * 0.3;
        const colH = bh * 0.62;
        cols.forEach((c, i) => {
          const cx = pad + i * (colW + pad);
          g.rect(cx, colY, colW, colH).fill(c).stroke({ width: 1.5, color: 0x1c1410 });
          g.rect(cx + colW * 0.12, colY + colH * 0.1, colW * 0.76, colH * 0.18).fill(0xffffff);
          g.rect(cx + colW * 0.12, colY + colH * 0.36, colW * 0.76, colH * 0.18).fill(0xffffff);
        });
        board.addChild(g);
        const label = new Text({ text: 'TASKS', style: { fontFamily: 'monospace', fontSize: Math.round(ts * 0.28), fill: 0x1c1410, fontWeight: 'bold' } });
        label.position.set(6, 2);
        board.addChild(label);
        board.eventMode = 'static';
        board.cursor = 'pointer';
        board.on('pointertap', () => useStore.getState().setTasksBoardOpen(true));
        world.addChild(board);
      }
      // The bottom-right open area is the cafeteria (break room) — see the
      // coffee-break director below. It is deliberately NOT added as overflow
      // desk seating, so the café tables stay free for breaks.

      // Waiting spots near the entrance — where a blocked agent walks to signal
      // it needs the user. Collected as walkable tiles in rings around the door.
      const entrance = mapRenderer.getSpawnPoint('entrance')
        ?? { x: Math.floor(mapRenderer.width / 2), y: mapRenderer.height - 2 };
      const waitTiles: Tile[] = [];
      const waitSeen = new Set<string>();
      for (let radius = 0; radius <= 6 && waitTiles.length < 16; radius++) {
        for (let dy = -radius; dy <= radius; dy++) {
          for (let dx = -radius; dx <= radius; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
            const x = entrance.x + dx, y = entrance.y + dy;
            const k = `${x},${y}`;
            if (waitSeen.has(k)) continue;
            if (mapRenderer.isWalkable(x, y)) { waitSeen.add(k); waitTiles.push({ x, y }); }
          }
        }
      }
      if (waitTiles.length === 0) waitTiles.push(entrance);

      // Seat 0 is desk-ceo — "Michael's room" — reserved for the god agent.
      // Seat 1 is reserved for his prep assistant ("Dwight") so it always sits in
      // the desk next to him. Everyone else claims from seat 2 onward.
      const GOD_SEAT = 0;
      const ASSISTANT_SEAT = 1;
      const claimSeat = (agent: Agent): number | null => {
        if (agent.isGod) { seatClaims.add(GOD_SEAT); return GOD_SEAT; }
        if (agent.isAssistant && seatTiles.length > ASSISTANT_SEAT) {
          seatClaims.add(ASSISTANT_SEAT); return ASSISTANT_SEAT;
        }
        for (let i = 2; i < seatTiles.length; i++) {
          if (!seatClaims.has(i)) { seatClaims.add(i); return i; }
        }
        return null;
      };

      // Face a seated agent toward their desk (the adjacent non-walkable
      // furniture). Standard desks put the monitor to the north and the chair to
      // the south, so the agent faces 'up' and we see their back — like a real
      // worker. Only a desk directly to the SOUTH (face 'down') puts furniture in
      // front of them, which is the one case the leg-crop tucks legs under.
      const facingForSeat = (t: Tile): 'up' | 'down' | 'left' | 'right' => {
        if (!mapRenderer.isWalkable(t.x, t.y - 1)) return 'up';
        if (!mapRenderer.isWalkable(t.x, t.y + 1)) return 'down';
        if (!mapRenderer.isWalkable(t.x - 1, t.y)) return 'left';
        if (!mapRenderer.isWalkable(t.x + 1, t.y)) return 'right';
        return 'up'; // open-floor overflow seat — no desk, just face away
      };

      // ─── Cafeteria: purposeful coffee breaks ───────────────────────────────
      // Idle / finished agents occasionally stroll to the break area, sit at a
      // café table (or stand at the coffee machine / vending machine), emit an
      // in-character one-liner, then head back. Two agents at the same table
      // trade a two-beat quip. This is what makes "lingering" feel purposeful.
      interface CafeSpot { tile: Tile; facing: Facing; spot: BreakSpot; seated: boolean; partner: number; }
      const cafeSpots: CafeSpot[] = [];

      // Stand spots face the first adjacent non-walkable tile (the appliance).
      const faceFurniture = (t: Tile): Facing => {
        if (!mapRenderer.isWalkable(t.x + 1, t.y)) return 'right';
        if (!mapRenderer.isWalkable(t.x - 1, t.y)) return 'left';
        if (!mapRenderer.isWalkable(t.x, t.y - 1)) return 'up';
        return 'down';
      };

      // Seats first (so partner indices are stable), then the standing spots.
      for (const name of ['cafe-seat-1', 'cafe-seat-2', 'cafe-seat-3', 'cafe-seat-4']) {
        const p = mapRenderer.getSpawnPoint(name);
        if (p) cafeSpots.push({ tile: p, facing: facingForSeat(p), spot: 'table', seated: true, partner: -1 });
      }
      // Pair the two seats that share a table (same column, two tiles apart).
      for (let i = 0; i < cafeSpots.length; i++) {
        for (let j = i + 1; j < cafeSpots.length; j++) {
          const a = cafeSpots[i].tile, b = cafeSpots[j].tile;
          if (a.x === b.x && Math.abs(a.y - b.y) === 2) { cafeSpots[i].partner = j; cafeSpots[j].partner = i; }
        }
      }
      for (const [name, spot] of [['cafe-stand-coffee', 'coffee'], ['cafe-stand-vending', 'vending']] as const) {
        const p = mapRenderer.getSpawnPoint(name);
        if (p) cafeSpots.push({ tile: p, facing: faceFurniture(p), spot, seated: false, partner: -1 });
      }
      const cafeTaken: (string | null)[] = new Array(cafeSpots.length).fill(null);

      const agentById = (id: string): Agent | undefined =>
        useStore.getState().agents.find((a) => a.id === id);

      const emitQuip = (id: string, rt: Runtime, spotIdx: number): void => {
        const spot = cafeSpots[spotIdx];
        const character = agentById(id)?.character ?? DEFAULT_CHARACTER;
        const seed = Math.floor(Math.random() * 1e6);
        rt.character.showThought(pickSoloLine(character, spot.spot, seed));
      };

      // If the newcomer's table-mate is already lingering (and neither is mid-
      // conversation), start a multi-beat exchange. The newcomer is the
      // initiator and owns the script; the partner just gets marked engaged.
      // Returns true if a chat was started.
      const maybePairChat = (id: string, rt: Runtime, spotIdx: number): boolean => {
        const spot = cafeSpots[spotIdx];
        if (spot.partner < 0 || !rt.brk) return false;
        const partnerId = cafeTaken[spot.partner];
        if (!partnerId) return false;
        const prt = runtimes.get(partnerId);
        if (!prt?.brk || prt.brk.phase !== 'lingering') return false;
        if (rt.brk.chat || rt.brk.chattingWith || prt.brk.chat || prt.brk.chattingWith) return false;
        const character = agentById(id)?.character ?? DEFAULT_CHARACTER;
        const lines = pickExchange(character, Math.floor(Math.random() * 1e6));
        rt.brk.chat = { lines, partnerId, idx: 0, beat: 0 };
        prt.brk.chattingWith = id;
        return true;
      };

      // Free a café seat and tidy up any conversation links so neither agent is
      // left mid-chat. Called when a break ends OR is interrupted by real work.
      const releaseBreak = (rt: Runtime): void => {
        if (!rt.brk) return;
        if (rt.brk.chat) {
          const p = runtimes.get(rt.brk.chat.partnerId);
          if (p?.brk) p.brk.chattingWith = undefined;
        }
        if (rt.brk.chattingWith) {
          const o = runtimes.get(rt.brk.chattingWith);
          if (o?.brk) o.brk.chat = undefined;
        }
        cafeTaken[rt.brk.spotIdx] = null;
        rt.brk = undefined;
      };

      // End a break gracefully: free the seat, drop the bubble, resume normal idle.
      const endBreak = (id: string, rt: Runtime): void => {
        releaseBreak(rt);
        rt.character.hideThought();
        const agent = agentById(id);
        if (agent?.isGod) rt.character.sitAtDesk(true);
        else rt.character.startWandering();
      };

      const startBreak = (id: string, rt: Runtime): void => {
        // Prefer (≈half the time) a seat whose table-mate is already there, so
        // pairs form and chat; otherwise any free spot.
        const free: number[] = [];
        const social: number[] = [];
        for (let i = 0; i < cafeSpots.length; i++) {
          if (cafeTaken[i]) continue;
          free.push(i);
          const p = cafeSpots[i].partner;
          if (p >= 0 && cafeTaken[p]) social.push(i);
        }
        if (free.length === 0) return;
        const pool = (social.length && Math.random() < 0.55) ? social : free;
        const idx = pool[Math.floor(Math.random() * pool.length)];
        const spot = cafeSpots[idx];
        cafeTaken[idx] = id;
        rt.brk = { spotIdx: idx, phase: 'walking', timer: 0, quipTimer: 0 };
        const c = rt.character;
        c.walkToAndThen(spot.tile, () => {
          // Bail if the break was cancelled or reassigned while walking.
          if (!rt.brk || rt.brk.spotIdx !== idx) return;
          if (spot.seated) c.sitInPlace(spot.facing);
          else { c.setIdle(); c.faceDirection(spot.facing); }
          rt.brk.phase = 'lingering';
          rt.brk.timer = 8 + Math.random() * 8;   // 8–16s of lingering
          rt.brk.quipTimer = 4 + Math.random() * 4;
          // Start a conversation if the table-mate is here; otherwise a solo quip.
          if (!maybePairChat(id, rt, idx)) emitQuip(id, rt, idx);
        });
      };

      const breakEligible = (agent: Agent, rt: Runtime): boolean => {
        if (agent.isGod || rt.brk) return false;
        if (agent.status !== 'idle' && agent.status !== 'success') return false;
        return !rt.character.isSitting();   // already parked at a desk → leave it
      };

      let cafeCooldown = 5;
      const updateCafeteria = (dt: number): void => {
        // Advance every in-progress break.
        for (const [id, rt] of runtimes) {
          const b = rt.brk;
          if (!b) continue;
          if (b.phase === 'walking') {
            b.timer += dt;
            if (b.timer > 20) endBreak(id, rt);   // never arrived — give up
            continue;
          }
          // lingering
          if (b.chat) {
            // Play the conversation one beat at a time, alternating speakers.
            b.chat.beat -= dt;
            if (b.chat.beat <= 0) {
              if (b.chat.idx < b.chat.lines.length) {
                const speaker = (b.chat.idx % 2 === 0) ? rt : runtimes.get(b.chat.partnerId);
                speaker?.character.showThought(b.chat.lines[b.chat.idx]);
                b.chat.idx++;
                b.chat.beat = 2.4;                // seconds per line
                b.timer = Math.max(b.timer, 3.5); // keep both around to finish
                const prt = runtimes.get(b.chat.partnerId);
                if (prt?.brk) prt.brk.timer = Math.max(prt.brk.timer, 3.5);
              } else {
                // Conversation over — release the partner and resume solo quips.
                const prt = runtimes.get(b.chat.partnerId);
                if (prt?.brk) prt.brk.chattingWith = undefined;
                b.chat = undefined;
              }
            }
          } else if (!b.chattingWith) {
            // Not in a conversation (and not being spoken to) — swap a solo quip.
            b.quipTimer -= dt;
            if (b.quipTimer <= 0) {
              b.quipTimer = 4 + Math.random() * 4;
              emitQuip(id, rt, b.spotIdx);
            }
            // Occasionally strike up a chat with a table-mate who arrived too.
            else if (Math.random() < 0.004) maybePairChat(id, rt, b.spotIdx);
          }
          b.timer -= dt;
          if (b.timer <= 0) endBreak(id, rt);
        }

        // Periodically send one idle agent on a break — but cap the room at 4.
        cafeCooldown -= dt;
        if (cafeCooldown > 0) return;
        cafeCooldown = 6 + Math.random() * 6;
        if (cafeTaken.filter(Boolean).length >= 4) return;
        if (Math.random() >= 0.7) return;          // not every window — keep it casual
        const candidates: Array<[Agent, Runtime]> = [];
        for (const agent of useStore.getState().agents) {
          const rt = runtimes.get(agent.id);
          if (rt && breakEligible(agent, rt)) candidates.push([agent, rt]);
        }
        if (candidates.length === 0) return;
        const [agent, rt] = candidates[Math.floor(Math.random() * candidates.length)];
        startBreak(agent.id, rt);
      };

      const addCharacter = async (agent: Agent) => {
        const charName = CAST_BY_NAME[agent.character] ? agent.character : DEFAULT_CHARACTER;
        const member = CAST_BY_NAME[charName];
        const seatIndex = claimSeat(agent);
        const seatTile: Tile = (seatIndex != null ? seatTiles[seatIndex] : undefined)
          ?? mapRenderer.getSpawnPoint('entrance')
          ?? { x: 2, y: 2 };
        const waitTile = waitTiles[(seatIndex ?? 0) % waitTiles.length];
        const frames = await getCastFrames(charName);
        // Bail if the agent was removed (or scene torn down) while loading.
        if (mountIdRef.current !== mountId) return;
        if (!useStore.getState().agents.some((a) => a.id === agent.id)) {
          if (seatIndex != null) seatClaims.delete(seatIndex);
          return;
        }
        const character = new Character({
          agentId: agent.id,
          mapRenderer,
          frames,
          seatTile,
          seatDirection: facingForSeat(seatTile),
          spawnTile: entrance, // walk in from the office door
          glowColor: hexNum(colors.accent[agent.accent]) ?? hexToNumber(member.shirt),
          onClick: (id) => useStore.getState().select(id),
        });
        character.show(charLayer);
        runtimes.set(agent.id, { character, seatIndex, waitTile, charName });
        applyState(agent, runtimes.get(agent.id)!, true);
      };

      const removeCharacter = (id: string) => {
        const rt = runtimes.get(id);
        if (!rt) return;
        releaseBreak(rt);                // free any café seat it was holding
        if (rt.seatIndex != null) seatClaims.delete(rt.seatIndex);
        rt.character.hide(0);
        // give the fade-out a moment, then destroy
        setTimeout(() => rt.character.destroy(), 700);
        runtimes.delete(id);
      };

      // Map an agent's store state onto its on-floor character.
      const applyState = (agent: Agent, rt: Runtime, force = false) => {
        const changed = force
          || rt.prevStatus !== agent.status
          || rt.prevAction !== agent.action
          || rt.prevCarrying !== agent.carrying
          || rt.prevPrompt !== agent.lastPrompt;
        if (!changed) return;
        rt.prevStatus = agent.status;
        rt.prevAction = agent.action;
        rt.prevCarrying = agent.carrying;
        rt.prevPrompt = agent.lastPrompt;

        const c = rt.character;
        c.setBaseAlpha(agent.status === 'ghost' ? 0.5 : 1);

        // While an agent is on a coffee break the director owns its avatar — a
        // mere idle/success refresh must not yank it back to wandering. Any
        // other live status (work, blocked, …) cancels the break and falls
        // through to normal handling, sending it back to its desk / the door.
        if (rt.brk) {
          if (agent.status === 'idle' || agent.status === 'success') {
            c.setStatusGlyph(agent.status === 'success' ? 'success' : 'none');
            return;
          }
          releaseBreak(rt);
        }

        // A thought cloud above the head shows what the agent is doing RIGHT NOW
        // (its live `action`, e.g. "edit App.tsx"). Working → sit at the desk;
        // blocked → walk to the door and flash "!"; done/idle → wander.
        switch (agent.status) {
          case 'working':
          case 'thinking':
            c.setStatusGlyph('none');
            c.sitAtDesk(true);
            c.showThought(liveActivity(agent), agent.carrying);
            break;
          case 'waiting':
            // Parked at the desk awaiting god / another agent — not actively
            // working (no focus glow) and NOT at the door (that's reserved for
            // agents that need the human).
            c.setStatusGlyph('none');
            c.sitAtDesk(false);
            c.showThought(liveActivity(agent, 'waiting'), agent.carrying);
            break;
          case 'blocked':
            c.setStatusGlyph('blocked');
            c.showThought(liveActivity(agent, 'needs you'));
            c.walkToTile(rt.waitTile);
            break;
          case 'compacting':
            // #5C — mid-/compact: stay put at the desk, "boxing up" glyph + thought,
            // so an agent compacting context reads as busy rather than frozen.
            c.setStatusGlyph('compacting');
            c.sitAtDesk(true);
            c.showThought(liveActivity(agent, 'compacting context'));
            break;
          case 'looping':
            // #5C — circuit-breaker armed (#6): hold position with the spinning
            // warning glyph so a runaway agent is visible on the floor.
            c.setStatusGlyph('looping');
            c.sitAtDesk(false);
            c.showThought(liveActivity(agent, 'looping — breaker armed'));
            break;
          case 'success':
            c.setStatusGlyph('success');
            c.hideThought();
            if (agent.isGod) c.sitAtDesk(true); else c.startWandering();
            break;
          case 'ghost':
            c.setStatusGlyph('none');
            c.hideThought();
            c.setIdle();
            break;
          case 'idle':
          default:
            c.setStatusGlyph('none');
            // The god runs the floor from its desk; everyone else wanders when idle.
            if (agent.isGod) { c.sitAtDesk(true); c.showThought(liveActivity(agent, 'running the floor')); }
            else { c.startWandering(); c.showThought(liveActivity(agent, 'idle')); }
            break;
        }
      };

      const syncAgents = () => {
        const { agents } = useStore.getState();
        const present = new Set(agents.map((a) => a.id));
        for (const id of Array.from(runtimes.keys())) {
          if (!present.has(id)) removeCharacter(id);
        }
        for (const agent of agents) {
          const rt = runtimes.get(agent.id);
          if (!rt) void addCharacter(agent);
          else applyState(agent, rt);
        }
      };

      syncAgents();

      let lastSelected: string | null = useStore.getState().selectedId;
      const unsubscribe = useStore.subscribe((s, prev) => {
        if (s.agents !== prev.agents) syncAgents();
        if (s.selectedId !== lastSelected) {
          lastSelected = s.selectedId;
          const rt = s.selectedId ? runtimes.get(s.selectedId) : undefined;
          if (rt) {
            const p = rt.character.getPixelPosition();
            camera.nudgeToward(p.x, p.y);
          }
        }
      });
      (app as any).__unsub = unsubscribe;

      // Fly an envelope from a sender's desk to each recipient when the hive
      // routes a message. Endpoints are snapshotted at spawn, so the paper flies
      // a clean arc even if the avatars wander mid-flight. 'human' recipients
      // (escalations) fly to the office door.
      const ts = mapRenderer.tileSize;
      const humanPos = { x: entrance.x * ts + ts / 2, y: entrance.y * ts + ts };
      const posFor = (id: string): { x: number; y: number } | null => {
        if (id === 'human') return humanPos;
        const rt = runtimes.get(id);
        return rt ? rt.character.getPixelPosition() : null;
      };
      const spawnHandoff = (fromId: string, toId: string, act: MessageAct, needsHuman: boolean) => {
        if (envelopes.length >= MAX_ENVELOPES) return;
        if (toId === fromId) return; // never mail yourself
        const from = posFor(fromId);
        const to = posFor(toId);
        if (!from || !to) return; // sender or recipient not on the floor
        const env = new MessageEnvelope(from, to, act, needsHuman);
        charLayer.addChild(env.container);
        envelopes.push(env);
      };

      // Real path: the main-process router emits one event per routed message.
      // Guarded so a stale preload bridge (e.g. before a dev-server restart adds
      // this method) degrades to "no envelopes" rather than crashing the floor.
      const offMessage = window.cth.onHiveMessage
        ? window.cth.onHiveMessage((e) => {
            for (const target of e.targets) spawnHandoff(e.from, target, e.act, e.needsHuman);
          })
        : () => { /* onHiveMessage unavailable — real handoffs disabled this session */ };
      // Demo path: with no live hive, the mock loop dispatches synthetic handoffs
      // so the animation is still visible. Clearly demo-only, fed by mockEvents.ts.
      const onDemoHandoff = (ev: Event) => {
        const d = (ev as CustomEvent<{ from: string; to: string; act: MessageAct }>).detail;
        if (d) spawnHandoff(d.from, d.to, d.act, false);
      };
      window.addEventListener('cth:demo-handoff', onDemoHandoff);
      (app as any).__offMessage = () => {
        offMessage();
        window.removeEventListener('cth:demo-handoff', onDemoHandoff);
      };

      // Keep two nearby thought clouds from covering each other: stack the
      // overlapping ones upward. Computed from each bubble's BASE rect (ignoring
      // the lift already applied) so the result is stable frame-to-frame.
      const resolveBubbleOverlaps = () => {
        const items: Array<{ rt: Runtime; x: number; y: number; w: number; h: number }> = [];
        for (const rt of runtimes.values()) {
          const lay = rt.character.getThoughtLayout();
          if (lay) items.push({ rt, ...lay });
        }
        if (items.length < 2) {
          for (const it of items) it.rt.character.setThoughtLift(0);
          return;
        }
        // Lower bubbles (greater bottom edge) and left-most ones hold their spot;
        // the rest get pushed above them. Deterministic ordering → no flicker.
        items.sort((a, b) => (b.y + b.h) - (a.y + a.h) || a.x - b.x);
        const placed: Array<{ x: number; y: number; w: number; h: number }> = [];
        const pad = 2;
        for (const it of items) {
          let y = it.y;
          let moved = true, guard = 0;
          while (moved && guard++ < 12) {
            moved = false;
            for (const p of placed) {
              const overlapX = it.x < p.x + p.w + pad && it.x + it.w + pad > p.x;
              const overlapY = y < p.y + p.h + pad && y + it.h + pad > p.y;
              if (overlapX && overlapY) { y = p.y - it.h - pad; moved = true; }
            }
          }
          placed.push({ x: it.x, y, w: it.w, h: it.h });
          it.rt.character.setThoughtLift(it.y - y);   // positive → shift up
        }
      };

      const onTick = (ticker: Ticker) => {
        const dt = ticker.deltaMS / 1000;
        camera.update(dt);
        // Thought clouds counter-scale against the camera so their text never
        // renders below 1:1 screen size when the window/world shrinks.
        const zoom = world.scale.x;
        for (const rt of runtimes.values()) {
          rt.character.setBubbleZoom(zoom);
          rt.character.update(dt);
        }
        updateCafeteria(dt);
        resolveBubbleOverlaps();
        for (let i = envelopes.length - 1; i >= 0; i--) {
          if (envelopes[i].update(dt)) {
            envelopes[i].destroy();
            envelopes.splice(i, 1);
          }
        }
      };
      app.ticker.add(onTick);

      const resize = new ResizeObserver((entries) => {
        for (const e of entries) {
          const { width, height } = e.contentRect;
          if (width === 0 || height === 0) continue;
          app.renderer?.resize(width, height);
          camera.setViewSize(width, height);
        }
      });
      resize.observe(host);
      (app as any).__resize = resize;
    };

    init().catch((err) => {
      if (mountIdRef.current !== mountId) return;
      console.error('[OfficeFloor] init failed:', err);
      const banner = document.createElement('div');
      banner.style.cssText =
        'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;' +
        'padding:24px;color:#ffd0b5;font-family:monospace;font-size:13px;text-align:center;white-space:pre-wrap;';
      banner.textContent = 'OfficeFloor failed to start:\n' + (err?.stack || err?.message || String(err));
      host.appendChild(banner);
    });

    return () => {
      mountIdRef.current++;
      const a = appRef.current;
      if (a) {
        (a as any).__resize?.disconnect?.();
        try { (a as any).__unsub?.(); } catch { /* noop */ }
        try { (a as any).__offMessage?.(); } catch { /* noop */ }
        safeDestroy(a);
      }
      appRef.current = null;
      while (host.firstChild) host.removeChild(host.firstChild);
    };
  }, []);

  return (
    <div
      ref={hostRef}
      style={{
        width: '100%', height: '100%',
        boxShadow: 'var(--cth-panel-border)',
        overflow: 'hidden',
        imageRendering: 'pixelated',
        background: hex(colors.ink[900]),
      }}
    />
  );
}

function hexNum(n: number): number { return n; }
function hex(n: number): string { return '#' + n.toString(16).padStart(6, '0'); }
function safeDestroy(app: Application) {
  try { app.ticker?.stop(); } catch { /* noop */ }
  try { app.destroy(true, { children: true }); } catch { /* noop */ }
}
