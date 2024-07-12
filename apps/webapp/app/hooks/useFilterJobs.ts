import { type ProjectJob } from "~/presenters/JobListPresenter.server";
import { useTextFilter } from "./useTextFilter";
import { useToggleFilter } from "./useToggleFilter";

export function useFilterJobs(jobs: ProjectJob[], onlyActiveJobs = false) {
  const toggleFilterRes = useToggleFilter<ProjectJob>({
    items: jobs,
    filter: (job, onlyActiveJobs) => {
      if (onlyActiveJobs && job.status !== "ACTIVE") {
        return false;
      }
      return true;
    },
    defaultValue: onlyActiveJobs,
  });

  const textFilterRes = useTextFilter<ProjectJob>({
    items: toggleFilterRes.filteredItems,
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

  return {
    filteredItems: textFilterRes.filteredItems,
    filterText: textFilterRes.filterText,
    setFilterText: textFilterRes.setFilterText,
    onlyActiveJobs: toggleFilterRes.isToggleActive,
    setOnlyActiveJobs: toggleFilterRes.setToggleActive,
  };
}
