"""One answer to a shortage of video memory, for every family: the same work in smaller pieces.

A computation that does not fit is not a creation that fails. Before 0.6.77 each pipeline had its
own answer, or none: an image encoded in one piece, an attention over the whole sequence, a
decode joined on the GPU, each a hard failure at the sizes the interface offers (the sweep of
17/11: six creations of twenty-one lost, one of them after seven minutes of sampling).

Two shapes, both slower rather than failing, neither changing what is computed:

- `smaller`: the same work tried in ways that hold less and less (whole, then in tiles, then in
  smaller tiles), each written by its caller;
- `in_pieces`: a work over a length (the rows of an attention, the frames of a video) cut in
  pieces, halved where one does not fit, what is done staying done.

The retry is made outside the handler of the error: the error keeps what the failed attempt held
until its handler ends, and the retry would not find that memory.
"""

import gc


def _released(torch):
    gc.collect()
    torch.cuda.empty_cache()


def smaller(attempts, torch, told=None):
    """The result of the first of `attempts` that does not run out of video memory.

    `attempts` are callables, the one that holds the most first (it is the fastest, or the one
    without seams). The error of the last is the caller's: nothing smaller was left to try.
    `told(place)`, when given, is told before each attempt after the first."""
    attempts = list(attempts)
    for place, attempt in enumerate(attempts):
        if place and told:
            told(place)
        try:
            return attempt()
        except torch.OutOfMemoryError:
            if place == len(attempts) - 1:
                raise
        _released(torch)
    raise ValueError('Nothing to attempt')


def in_pieces(run, length, torch, unit=1, first=None):
    """`run(start, stop)` over [0, length), in pieces halved each time the video memory lacks
    for one. A piece that ran is not run again: `run` may write its result where it read.

    Pieces are multiples of `unit` (the last one ends the length) and never smaller: the error is
    then the caller's. `first` is the size of the first pieces (the whole length without it).
    Returns the number of pieces."""
    size = max(unit, (first or length) // unit * unit)
    start = count = 0
    while start < length:
        stop = min(length, start + size)
        try:
            run(start, stop)
            start, count = stop, count + 1
            continue
        except torch.OutOfMemoryError:
            if size <= unit:
                raise
        _released(torch)
        size = max(unit, size // 2 // unit * unit)
    return count
