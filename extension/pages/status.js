// One-line result page: status.html?kind=ok|error&text=...
const params = new URLSearchParams(location.search);
const ok = params.get('kind') === 'ok';

document.getElementById('card').classList.add(ok ? 'ok' : 'fail');
document.getElementById('text').textContent = params.get('text') || (ok ? 'Done.' : 'Something went wrong.');
document.getElementById('note').hidden = !ok;
document.title = ok ? 'Done - Brainrot Buddy' : 'Error - Brainrot Buddy';
