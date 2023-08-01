import { ProjectJob } from "./useJobs";
import { useTextFilter } from "./useTextFilter";

export function useFilterJobs(jobs: ProjectJob[]) {
  const { filterText, setFilterText, filteredItems } = useTextFilter<ProjectJob>({
    items: jobs,
    filter: (job, text) => {
      if (job.slug.toLowerCase().includes(text.toLowerCase())) return true;
      if (job.title.toLowerCase().includes(text.toLowerCase())) return true;
      if (job.event.title.toLowerCase().includes(text.toLowerCase())) return true;
      if (
        job.integrations.some((integration) =>
          integration.title.toLowerCase().includes(text.toLowerCase())
        )
      )
        return true;
      if (
        job.properties &&
        job.properties.some((property) => property.text.toLowerCase().includes(text.toLowerCase()))
      )
        return true;

      return false;
    },
  });

  return { filterText, setFilterText, filteredItems };
}
