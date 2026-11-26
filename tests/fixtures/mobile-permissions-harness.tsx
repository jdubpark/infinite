import { createRoot } from "react-dom/client";
import { PermissionLog } from "../../apps/mobile/src/features/permissions/PermissionLog";

const connection = { id: "machine-1", url: "http://127.0.0.1", token: "test-token" };

createRoot(document.getElementById("root")!).render(<PermissionLog connection={connection} />);
