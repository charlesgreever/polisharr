import { useEffect, type CSSProperties } from "react";

const page: CSSProperties = {
  width: 1200,
  height: 630,
  overflow: "hidden",
  background: "#0c111d",
  color: "#fcfcfd",
  fontFamily: "Outfit, ui-sans-serif, sans-serif",
  position: "relative",
};

export function OgImagePage() {
  useEffect(() => {
    const root = document.documentElement;
    const previousRoot = root.style.background;
    const previousBody = document.body.style.background;
    root.style.background = "#0c111d";
    document.body.style.background = "#0c111d";
    return () => {
      root.style.background = previousRoot;
      document.body.style.background = previousBody;
    };
  }, []);
  return (
    <main style={page} aria-label="Polisharr social preview">
      <div style={{
        position: "absolute",
        width: 720,
        height: 720,
        left: -180,
        top: -200,
        background: "radial-gradient(circle, rgba(70, 95, 255, 0.42), rgba(70, 95, 255, 0) 66%)",
      }} />
      <div style={{
        position: "relative",
        height: 630,
        display: "grid",
        gridTemplateColumns: "1fr 460px",
        alignItems: "center",
        padding: "0 64px 0 72px",
        gap: 28,
      }}>
        <div>
          <div style={{
            width: 68,
            height: 68,
            borderRadius: 16,
            background: "#465fff",
            display: "grid",
            placeItems: "center",
            fontWeight: 650,
            fontSize: 34,
            color: "#fff",
            boxShadow: "0 12px 32px rgba(70, 95, 255, 0.4)",
          }}>P</div>
          <h1 style={{
            margin: "20px 0 0",
            fontSize: 64,
            fontWeight: 600,
            letterSpacing: "-0.04em",
            lineHeight: 0.95,
          }}>Polisharr</h1>
          <p style={{
            margin: "16px 0 0",
            maxWidth: 500,
            fontSize: 22,
            lineHeight: 1.35,
            fontWeight: 450,
            color: "#98a2b3",
          }}>
            Inspect the library Radarr and Sonarr already know. Suggest a smaller file. The original stays until you Keep.
          </p>
          <ul style={{ listStyle: "none", margin: "26px 0 0", padding: 0, display: "flex", flexDirection: "column", gap: 12 }}>
            {[
              "HEVC or AV1, plus cleaner tracks",
              "Listen to audio, read subtitles",
              "Watch Jellyfin playback",
              "Sidecar you Keep or Discard",
            ].map((line) => (
              <li key={line} style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 18, fontWeight: 500, color: "#e4e7ec" }}>
                <i style={{ width: 8, height: 8, borderRadius: 99, background: "#465fff", flex: "none" }} />
                {line}
              </li>
            ))}
          </ul>
        </div>
        <section style={{
          border: "1px solid #1d2939",
          background: "rgba(255, 255, 255, 0.035)",
          borderRadius: 22,
          padding: "20px 20px 16px",
          boxShadow: "0 24px 60px rgba(0, 0, 0, 0.28)",
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
            <strong style={{ fontSize: 16 }}>Library</strong>
            <span style={{ fontSize: 13, color: "#98a2b3", fontWeight: 500 }}>Idle</span>
          </div>
          <OgRow title="Suggestions" detail="Smaller files and cleaner tracks" chip="Work" />
          <OgRow title="Review" detail="Sidecar waiting for Keep" chip="Keep" />
          <OgRow title="Playback" detail="Jellyfin conversions" chip="Jellyfin" />
          <OgRow title="Queue" detail="Hardware encode, when you say so" chip="Encode" />
          <p style={{ margin: "14px 0 0", fontSize: 13, color: "#98a2b3", fontWeight: 500 }}>The library file stays until Keep.</p>
        </section>
      </div>
    </main>
  );
}

function OgRow({ title, detail, chip }: { title: string; detail: string; chip: string }) {
  return (
    <div style={{
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 16,
      border: "1px solid #1d2939",
      background: "rgba(12, 17, 29, 0.55)",
      borderRadius: 14,
      padding: "12px 14px",
      marginTop: 10,
    }}>
      <div>
        <b style={{ display: "block", fontSize: 16 }}>{title}</b>
        <span style={{ display: "block", marginTop: 2, fontSize: 13, color: "#98a2b3" }}>{detail}</span>
      </div>
      <span style={{
        height: 28,
        padding: "0 10px",
        borderRadius: 999,
        background: "rgba(70, 95, 255, 0.16)",
        color: "#9cb9ff",
        fontSize: 12,
        fontWeight: 600,
        display: "inline-flex",
        alignItems: "center",
      }}>{chip}</span>
    </div>
  );
}
