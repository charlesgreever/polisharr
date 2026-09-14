export function arrAppName(type: "movie" | "episode"): "Radarr" | "Sonarr" {
  return type === "episode" ? "Sonarr" : "Radarr";
}

export function replaceSearchConfirm(arrName: string, sharedLabel?: string | null): string {
  const shared = sharedLabel ? ` ${sharedLabel} also goes away.` : "";
  return `This removes the current file from the library and asks ${arrName} to search again.${shared} The next grab follows ${arrName}'s quality profile.`;
}

export function untrackConfirm(arrName: string, title: string, kind: "movie" | "series"): string {
  if (kind === "series") {
    return `${arrName} will stop tracking ${title}, delete every episode file, and will not keep this series.`;
  }
  return `${arrName} will stop tracking ${title}, delete its files, and will not keep this movie.`;
}
