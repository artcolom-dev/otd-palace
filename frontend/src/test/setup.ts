import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeAll } from "vitest";
import { resetPhotoStart } from "../components/PlayerAvatar";
import { preloadViews } from "../views/lazy";

// Prices and Passes are split from the first bundle; with their code in, they render at once, as after a real visit.
beforeAll(() => preloadViews());

// A page asks for its faces a moment after it paints; in the tests that moment has passed.
beforeAll(() => resetPhotoStart(true));

afterEach(() => {
  cleanup();
});
