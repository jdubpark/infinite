import { createRoot } from "react-dom/client";
import { MachineProvider } from "../../apps/web/src/machines";
import { PermissionPicker } from "../../apps/web/src/permissions";

createRoot(document.getElementById("root")!).render(
  <MachineProvider>
    <PermissionPicker selected={null} onSelect={() => {}} onOverview={() => {}} />
  </MachineProvider>,
);
