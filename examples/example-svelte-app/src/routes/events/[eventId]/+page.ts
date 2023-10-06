import type { PageLoad } from './$types';

export const load: PageLoad = ({ params }) => {
    return {
        eventId: params.eventId
};
};
export const ssr = false;
