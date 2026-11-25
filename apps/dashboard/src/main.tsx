import { createRoot } from "react-dom/client";
// the old dashboard's stylesheet, as it is: the same classes, the same look (moves here when the old one is removed)
import "../../backend/dashboard/styles.css";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(<App />);
