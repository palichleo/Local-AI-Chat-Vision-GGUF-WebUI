"""The coloured masks SCAIL-2 reads, made from a video and a few words: who is who.

SAM 3.1's detector (runner.models.sam3) finds in every frame the objects the phrases name
("girl, handkerchief"). An object keeps its place from one frame to the next: the phrase that
named it and, when a phrase names several, the object of the frame before it covers best. Each
object then takes a colour of the model's palette, in the order they appear in the video and
from left to right within a frame; where two overlap the first one shows. The same order in
the reference image and in the driving video gives the same colour to the character to draw
and to the person to follow.
"""

# The colours the model was trained on, in this order (zai-org/SCAIL-2): blue, red, green,
# magenta, cyan, yellow. From -1 to 1.
PALETTE = (
    (-1.0, -1.0, 1.0),
    (1.0, -1.0, -1.0),
    (-1.0, 1.0, -1.0),
    (1.0, -1.0, 1.0),
    (-1.0, 1.0, 1.0),
    (1.0, 1.0, -1.0),
)
WHITE, BLACK = 1.0, -1.0
THRESHOLD = 0.5
# An object found once is followed on a weaker score than it took to find it: one frame where
# the phrase fits it less well does not make it vanish for that frame.
KEPT = 0.25
BATCH = 4
# Masks looked at for a phrase beyond the objects it may name: what it also fits and that
# another phrase names better (a scarf on the head of the girl, for "handkerchief").
SPARE = 3
# Two masks are one object when one covers this share of the other.
SAME = 0.5


def overlap(one, other):
    """Share of the smaller of two masks that the other covers."""
    smaller = min(one.sum().item(), other.sum().item())
    return (one & other).sum().item() / smaller if smaller else 0.0


def distinct(candidates):
    """The candidates of a frame, (score, phrase, ...mask last), best score first, without
    those that a better one already covers: a thing is one object, named by the phrase that
    fits it best, and a part of an object (its scarf) is not another."""
    kept = []
    for item in sorted(candidates, key=lambda item: item[0], reverse=True):
        if all(overlap(item[-1], other[-1]) < SAME for other in kept):
            kept.append(item)
    return kept


def assigned(found, before, most):
    """Places for the masks found in a frame for one phrase: {place: index in `found`}. A mask
    takes the place of the object of the frame before that it covers best; the others take the
    free places, in the order they were found (best score first)."""
    places, taken = {}, set()
    pairs = sorted(
        ((overlap(mask, old), place, index) for index, mask in enumerate(found) for place, old in before.items()),
        reverse=True,
    )
    for share, place, index in pairs:
        if share <= 0 or place in places or index in taken:
            continue
        places[place] = index
        taken.add(index)
    free = [place for place in range(most) if place not in places and place not in before]
    for index in range(len(found)):
        if index not in taken and free:
            places[free.pop(0)] = index
            taken.add(index)
    return places


class Follower:
    """Follows the objects of a list of phrases through the frames it is fed, in order."""

    def __init__(self, model, texts, threshold=THRESHOLD, kept=KEPT):
        # texts: [(text features, mask, most objects)], one entry a phrase.
        self.model, self.texts = model, texts
        self.threshold, self.kept = threshold, kept
        self.slots = [slot for index, (_text, _mask, most) in enumerate(texts) for slot in range(most)]
        self.offsets = [sum(most for _t, _m, most in texts[:index]) for index in range(len(texts))]
        self.count = sum(most for _text, _mask, most in texts)
        self.before = [{} for _ in texts]
        self.known = [set() for _ in texts]
        self.frames = []  # one entry a frame: {object: mask of probabilities [288, 288] on the CPU}
        self.scores = []

    def feed(self, pictures):
        """`pictures`: [batch, 3, height, width] from -1 to 1, the next frames of the video."""
        from runner.models import sam3

        features = sam3.image_features(self.model, pictures)
        batch = pictures.shape[0]
        candidates = [[] for _ in range(batch)]
        for phrase, (text, mask, most) in enumerate(self.texts):
            # Everything that could be an object already followed; the stricter score is asked
            # below of an object not seen yet.
            results = sam3.detect(self.model, features, text, mask, self.kept, most=most + SPARE)
            for index, (scores, masks) in enumerate(results):
                solid = masks > 0.5
                candidates[index] += [
                    (scores[pick].item(), phrase, masks[pick], solid[pick]) for pick in range(len(scores))
                ]
        found = [{} for _ in range(batch)]
        scored = [{} for _ in range(batch)]
        for index in range(batch):
            apart = distinct(candidates[index])
            for phrase, (_text, _mask, most) in enumerate(self.texts):
                mine = [item for item in apart if item[1] == phrase][:most]
                places = assigned([solid for _score, _phrase, _mask, solid in mine], self.before[phrase], most)
                kept = {}
                for place, pick in places.items():
                    score, _phrase, mask, solid = mine[pick]
                    if place not in self.known[phrase] and score <= self.threshold:
                        continue
                    self.known[phrase].add(place)
                    kept[place] = solid
                    found[index][self.offsets[phrase] + place] = mask.half().cpu()
                    scored[index][self.offsets[phrase] + place] = round(score, 3)
                # An object missing from a frame keeps the place it had when last seen.
                self.before[phrase] = {**self.before[phrase], **kept}
        self.frames += found
        self.scores += scored


def order(frames, count):
    """The objects in the order of their colours: first seen first, then from left to right
    (the middle of the mask in the frame where it first shows). Objects never seen are left out."""
    import torch

    first = {}
    for index, frame in enumerate(frames):
        for item, mask in frame.items():
            if item in first:
                continue
            solid = mask.float() > 0.5
            if not solid.any():
                continue
            columns = torch.arange(solid.shape[-1], dtype=torch.float32)
            first[item] = (index, (solid.float().sum(dim=0) * columns).sum().item() / solid.sum().item())
    return sorted(first, key=lambda item: first[item])[: len(PALETTE)]


def coloured(frame, ranked, height, width, background=WHITE):
    """[3, height, width] from -1 to 1: the masks of a frame in their colours on `background`
    (white over a driving video whose character is replaced, black over the reference)."""
    import torch
    import torch.nn.functional as F

    picture = torch.full((3, height, width), float(background))
    # Painted last to first: where two objects overlap, the first one shows.
    for rank in range(len(ranked) - 1, -1, -1):
        mask = frame.get(ranked[rank])
        if mask is None:
            continue
        grown = F.interpolate(mask.float()[None, None], size=(height, width), mode='bilinear', align_corners=False)
        solid = grown[0, 0] > 0.5
        colour = torch.tensor(PALETTE[rank]).view(3, 1, 1)
        picture = torch.where(solid[None], colour, picture)
    return picture


def texts_of(model, pieces, prompt):
    """[(text features, mask, most objects)] of a prompt's phrases (runner.models.sam3.phrases)."""
    from runner.models import sam3

    found = []
    for phrase, most in sam3.phrases(prompt):
        ids, mask = sam3.token_ids(phrase, pieces)
        found.append((sam3.text_features(model, ids, mask), mask, most))
    if not found:
        raise ValueError('No subject to look for')
    return found


def follow(model, pieces, prompt, pictures, batch=BATCH, progress=None):
    """A Follower fed every picture of an iterable of [3, height, width] tensors."""
    import torch

    follower = Follower(model, texts_of(model, pieces, prompt))
    waiting = []
    for picture in pictures:
        waiting.append(picture)
        if len(waiting) == batch:
            follower.feed(torch.stack(waiting))
            waiting = []
            if progress:
                progress(len(follower.frames))
    if waiting:
        follower.feed(torch.stack(waiting))
    return follower
