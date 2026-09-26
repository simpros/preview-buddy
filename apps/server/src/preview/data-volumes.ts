import type { DataVolumeRef } from "@sprout/preview-env";
import type { PreviewDocker } from "../docker/port.ts";
import { parseDataVolumeName } from "./naming.ts";

/** Docker volumes this control plane owns, behind one port like previewDb. */
export type PreviewDataVolumes = {
  listDataVolumes: () => Promise<DataVolumeRef[]>;
  removeDataVolumes: (slug: string, prId: number) => Promise<void>;
};

export function bindPreviewDataVolumes(
  docker: PreviewDocker,
): PreviewDataVolumes {
  async function listDataVolumes(): Promise<DataVolumeRef[]> {
    const out: DataVolumeRef[] = [];
    for (const name of await docker.listVolumes()) {
      const parsed = parseDataVolumeName(name);
      if (!parsed) continue;
      out.push({ name, ...parsed });
    }
    return out;
  }
  return {
    listDataVolumes,
    removeDataVolumes: async (slug, prId) => {
      const owned = (await listDataVolumes()).filter(
        (ref) => ref.slug === slug && ref.prId === prId,
      );
      await Promise.all(owned.map((ref) => docker.removeVolume(ref.name)));
    },
  };
}
