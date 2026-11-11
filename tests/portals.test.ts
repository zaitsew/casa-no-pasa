import { describe, expect, it } from "vitest";
import { detectPortal, detectPortals } from "../src/engine/portals";

describe("detectPortal", () => {
  it("reads idealista ids", () => {
    expect(detectPortal("https://www.idealista.com/inmueble/12345678/")).toMatchObject({ source: "idealista", portalId: "12345678" });
  });
  it("reads fotocasa ids", () => {
    expect(detectPortal("https://www.fotocasa.es/es/alquiler/vivienda/barcelona-capital/calle-inventada/180000001/d?x=1")).toMatchObject({ source: "fotocasa", portalId: "180000001" });
  });
  it("reads habitaclia ids", () => {
    expect(detectPortal("https://www.habitaclia.com/alquiler-piso-calle_inventada-barcelona-i4000012345.htm")).toMatchObject({ source: "habitaclia", portalId: "4000012345" });
  });
  it("reads pisos.com and badi ids", () => {
    expect(detectPortal("https://www.pisos.com/alquilar/piso-gracia-barcelona-12345678_100000/")).toMatchObject({ source: "pisos", portalId: "12345678" });
    expect(detectPortal("https://badi.com/es/room/99887766")).toMatchObject({ source: "badi", portalId: "99887766" });
  });
  it("recognises social links without an id", () => {
    expect(detectPortal("https://www.instagram.com/stories/inventado/123/")).toEqual({ source: "instagram", url: "https://www.instagram.com/stories/inventado/123/" });
    expect(detectPortal("https://m.facebook.com/groups/inventado/posts/1")?.source).toBe("facebook");
    expect(detectPortal("https://t.me/inventado/42")?.source).toBe("telegram");
  });
  it("ignores other hosts and look-alikes", () => {
    expect(detectPortal("https://example.com/inmueble/123")).toBeNull();
    expect(detectPortal("https://idealista.com.evil.example/inmueble/123")).toBeNull();
    expect(detectPortal("not a url")).toBeNull();
  });
});

describe("detectPortals", () => {
  it("finds every link in a text once, without trailing punctuation", () => {
    const hits = detectPortals("Mira https://www.idealista.com/inmueble/111111/, y https://www.idealista.com/inmueble/222222. Otra vez https://www.idealista.com/inmueble/111111/,");
    expect(hits.map((h) => h.portalId)).toEqual(["111111", "222222"]);
  });
});
