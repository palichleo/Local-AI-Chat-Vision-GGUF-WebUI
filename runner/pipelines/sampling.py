"""The validated Euler/simple sigma schedule, bounded by requested diffusion steps."""
import math


def simple_sigmas(steps, denoise, torch):
    count=steps/denoise
    if math.isfinite(count):total=max(steps,int(count))
    else:
        numerator,denominator=denoise.as_integer_ratio()
        total=max(steps,steps*denominator//numerator)
    grid=torch.arange(1,10001,dtype=torch.float32)/10000
    shifted=math.exp(1.15)/(math.exp(1.15)+(1/grid-1))
    return [float(shifted[-(1+i*10000//total)]) for i in range(total-steps,total)]+[0.]
