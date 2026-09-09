import { Navigate, Route, Routes } from "react-router-dom";
import { useEffect, useState } from "react";
import { api, type FirstRun } from "./api";
import { Shell } from "./components/Shell";
import { HomePage } from "./pages/Home";
import { MoviesPage } from "./pages/Movies";
import { SeriesPage } from "./pages/Series";
import { SuggestionsPage } from "./pages/Suggestions";
import { QueuePage } from "./pages/Queue";
import { ReviewPage } from "./pages/Review";
import { ErrorsPage } from "./pages/Errors";
import { HistoryPage } from "./pages/History";
import { SettingsPage } from "./pages/Settings";
import { TitlePage } from "./pages/Title";
import { LoginPage } from "./pages/Login";
import { SetupPage } from "./pages/Setup";
import { WorkerPage } from "./pages/Worker";

export function App() {
  const [auth, setAuth] = useState<{ authenticated: boolean; firstRun: FirstRun; version?: string; role?: "standalone" | "master" | "worker" } | null>(null);

  useEffect(() => {
    void api.status().then(setAuth).catch(() => setAuth({ authenticated: false, firstRun: emptyFirst() }));
  }, []);

  if (!auth) {
    return <main className="auth-page" />;
  }
  if (auth.role === "worker") {
    return <WorkerPage />;
  }

  const signedOut = !auth.firstRun.hasAdmin || !auth.authenticated;
  if (signedOut) {
    const firstRun = auth?.firstRun ?? { hasAdmin: true, languageConfirmed: false, hasReviewPath: false, hasArr: false, complete: false };
    return (
      <Routes>
        <Route path="/login" element={<LoginPage firstRun={firstRun} />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }
  if (!auth.firstRun.complete) {
    return <SetupPage firstRun={auth.firstRun} onReady={() => void api.status().then(setAuth)} />;
  }

  return (
    <Shell version={auth.version}>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/movies" element={<MoviesPage />} />
        <Route path="/movies/:id" element={<TitlePage />} />
        <Route path="/series" element={<SeriesPage />} />
        <Route path="/series/episodes/:id" element={<TitlePage />} />
        <Route path="/suggestions" element={<SuggestionsPage />} />
        <Route path="/queue" element={<QueuePage />} />
        <Route path="/review" element={<ReviewPage />} />
        <Route path="/errors" element={<ErrorsPage />} />
        <Route path="/history" element={<HistoryPage />} />
        <Route path="/settings" element={<SettingsPage firstRun={auth.firstRun} onChange={() => void api.status().then(setAuth)} />} />
        <Route path="/login" element={<Navigate to="/" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Shell>
  );
}

function emptyFirst(): FirstRun {
  return { hasAdmin: false, languageConfirmed: false, hasReviewPath: false, hasArr: false, complete: false };
}
