import { describe, expect, it } from "vitest";
import { arrAppName, replaceSearchConfirm, untrackConfirm } from "./library-replace.ts";

describe("library replace copy", () => {
  it("names Radarr or Sonarr and warns when a shared file would go away", () => {
    expect(arrAppName("movie")).toBe("Radarr");
    expect(arrAppName("episode")).toBe("Sonarr");
    expect(replaceSearchConfirm("Sonarr")).toMatch(/Sonarr to search again/);
    expect(replaceSearchConfirm("Sonarr")).toMatch(/quality profile/);
    expect(replaceSearchConfirm("Sonarr", "Same file as S08E36")).toMatch(/Same file as S08E36 also goes away/);
  });

  it("says stop tracking deletes files for a movie or a whole series", () => {
    expect(untrackConfirm("Radarr", "Dune", "movie")).toBe(
      "Radarr will stop tracking Dune, delete its files, and will not keep this movie.",
    );
    expect(untrackConfirm("Sonarr", "SpongeBob SquarePants", "series")).toBe(
      "Sonarr will stop tracking SpongeBob SquarePants, delete every episode file, and will not keep this series.",
    );
  });
});
