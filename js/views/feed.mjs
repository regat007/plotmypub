// PlotMyPub — Feed tab. Home of the group's leaderboard + recent activity.
// The markup lives in index.html (#panel, inside .feed-view) and is wired up by
// map.mjs via shared element IDs; here we just register it as a routable view.
import { registerView } from '../router.mjs';

registerView('feed', { el: document.querySelector('.view-ph[data-view="feed"]') });
