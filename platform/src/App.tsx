import { useState, useEffect } from "react";
import { authClient } from "./lib/auth-client";
import { Dashboard } from "./pages/Dashboard";
import { Landing } from "./pages/Landing";

/**
 * Root application component for Companion Cloud.
 *
 * Auth-aware routing using Better Auth's useSession hook:
 * - Unauthenticated → Landing page (login/signup + pricing)
 * - Authenticated   → Dashboard (instance management)
 *
 * Hash-based routing for sub-pages:
 * - #/dashboard  → Dashboard (default for authenticated users)
 * - #/onboarding → Onboarding flow
 * - default      → Landing page
 */
export default function App() {
  const [hash, setHash] = useState(window.location.hash);
  const session = authClient.useSession();

  useEffect(() => {
    const onHashChange = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  // Show loading state while checking session
  if (session.isPending) {
    return <div>Loading...</div>;
  }

  // Unauthenticated → landing page
  if (!session.data) {
    return <Landing />;
  }

  // Authenticated → dashboard
  if (hash.startsWith("#/dashboard") || !hash) {
    return <Dashboard />;
  }

  return <Landing />;
}
